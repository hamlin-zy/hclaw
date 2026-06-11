import {ipcMain, shell} from 'electron';
import axios from 'axios';
import http from 'http';
import {getMainWindow} from '../window';

// Google OAuth2 凭据配置
// 重要：请务必替换为你在 Google Cloud Console 中创建的“桌面应用”凭据
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';

export class GoogleAuthService {
    private static _server: http.Server | null = null;

    /** 获取 Google 授权 URL */
    static getAuthUrl(port: number) {
        if (GOOGLE_CLIENT_ID.includes('替换为你的')) {
            throw new Error('请先在 src/main/auth/googleAuth.ts 中配置您的 GOOGLE_CLIENT_ID');
        }

        const redirectUri = `http://127.0.0.1:${port}`;
        // 使用您在控制台中确认为有效的范围
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
            prompt: 'consent'
        });

        return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    /** 使用授权码交换 Token */
    static async exchangeCodeForToken(code: string, port: number) {
        const redirectUri = `http://127.0.0.1:${port}`;
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            code,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
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

    /** 刷新 Access Token */
    static async refreshAccessToken(refreshToken: string) {
        const response = await axios.post('https://oauth2.googleapis.com/token', {
            refresh_token: refreshToken,
            client_id: GOOGLE_CLIENT_ID,
            client_secret: GOOGLE_CLIENT_SECRET,
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
