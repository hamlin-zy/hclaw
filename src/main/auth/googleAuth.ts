import {randomBytes, createHash} from 'crypto';
import {ipcMain, shell} from 'electron';
import axios from 'axios';
import http from 'http';
import {getMainWindow} from '../window';

// Google OAuth2 凭据配置
// GOOGLE_CLIENT_ID 是公开标识，可放心硬编码或通过环境变量覆盖
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
    || '150971104661-h4p7h7p42vp3vp2muqnjt3itqfes90ie.apps.googleusercontent.com';

/** 生成 PKCE code_verifier（随机字符串，43-128 字符） */
function generateCodeVerifier(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const array = randomBytes(64);
    return Array.from(array).map(b => chars[b % chars.length]).join('');
}

/** 根据 code_verifier 生成 code_challenge（S256 方法） */
function generateCodeChallenge(verifier: string): string {
    return createHash('sha256')
        .update(verifier)
        .digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export class GoogleAuthService {
    private static _server: http.Server | null = null;
    /** 暂存本次 PKCE 流程的 code_verifier，授权回调时使用 */
    private static _pendingCodeVerifier: string | null = null;

    /** 获取 Google 授权 URL（PKCE 流程，不需要 client_secret） */
    static getAuthUrl(port: number) {
        if (GOOGLE_CLIENT_ID.includes('替换为你的')) {
            throw new Error('请先在 src/main/auth/googleAuth.ts 中配置您的 GOOGLE_CLIENT_ID');
        }

        // 生成 PKCE 参数
        const codeVerifier = generateCodeVerifier();
        GoogleAuthService._pendingCodeVerifier = codeVerifier;
        const codeChallenge = generateCodeChallenge(codeVerifier);

        const redirectUri = `http://127.0.0.1:${port}`;
        const scopes = [
            'https://www.googleapis.com/auth/userinfo.email',
            'https://www.googleapis.com/auth/userinfo.profile',
            'https://www.googleapis.com/auth/generative-language.retriever'
        ];

        const params = new URLSearchParams({
            client_id: GOOGLE_CLIENT_ID,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: scopes.join(' '),
            access_type: 'offline',
            prompt: 'consent',
            code_challenge_method: 'S256',
            code_challenge: codeChallenge,
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    /** 使用授权码交换 Token（PKCE 流程，用 code_verifier 代替 client_secret） */
    static async exchangeCodeForToken(code: string, port: number) {
        const codeVerifier = GoogleAuthService._pendingCodeVerifier;
        GoogleAuthService._pendingCodeVerifier = null; // 一次性使用

        const redirectUri = `http://127.0.0.1:${port}`;
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            code,
            client_id: GOOGLE_CLIENT_ID,
            code_verifier: codeVerifier,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
        });

        const data = response.data;
        return {
            accessToken: data.access_token,
            refreshToken: data.refresh_token,
            expiryDate: Date.now() + (data.expires_in * 1000),
            tokenType: data.token_type
        };
    }

    /** 刷新 Access Token（桌面应用可省略 client_secret） */
    static async refreshAccessToken(refreshToken: string) {
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            refresh_token: refreshToken,
            client_id: GOOGLE_CLIENT_ID,
            grant_type: 'refresh_token',
        });

        const data = response.data;
        return {
            accessToken: data.access_token,
            expiryDate: Date.now() + (data.expires_in * 1000)
        };
    }

    /** 获取用户信息 */
    static async getUserInfo(accessToken: string) {
        const response = await axios.get('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: {Authorization: `Bearer ${accessToken}`}
        });
        return response.data; // 包含 email, name, picture 等
    }
}

/** 注册 Google 认证相关的 IPC Handlers */
export function initGoogleAuthIPC() {
    ipcMain.handle('auth-google-login', async () => {
        return new Promise((resolve) => {
            const server = http.createServer(async (req, res) => {
                const url = new URL(req.url!, `http://${req.headers.host}`);
                const code = url.searchParams.get('code');

                if (code) {
                    res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
                    res.end('<h1>授权成功！</h1><p>您可以关闭此窗口并返回 HClaw 继续操作。</p>');

                    const port = (server.address() as any).port;

                    try {
                        const tokens = await GoogleAuthService.exchangeCodeForToken(code, port);
                        const userInfo = await GoogleAuthService.getUserInfo(tokens.accessToken);

                        const win = getMainWindow();
                        if (win && !win.isDestroyed()) {
                            win.webContents.send('google-auth-success', {
                                ...tokens,
                                email: userInfo.email,
                                name: userInfo.name,
                                picture: userInfo.picture
                            });
                        }
                        resolve({success: true});
                    } catch (err: any) {
                        resolve({success: false, error: err.message});
                    }

                    setTimeout(() => {
                        server.close();
                    }, 1000);
                } else {
                    res.writeHead(400);
                    res.end('Authorization code not found');
                }
            });

            server.listen(0, '127.0.0.1', () => {
                const port = (server.address() as any).port;
                const url = GoogleAuthService.getAuthUrl(port);
                shell.openExternal(url);
            });
        });
    });
}
