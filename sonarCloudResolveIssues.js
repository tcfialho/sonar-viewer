const vscode = require('vscode');
const https = require('https');
const querystring = require('querystring');
const crypto = require('crypto');
const { addSonarCommentsToFile } = require('./sonarCloudComments');
const { getCurrentGitBranch } = require('./utils');

// Configuração da aplicação
const config = {
    clientId: 'stackspot-vscode-extension',
    redirectUri: 'vscode://sonar.viewer/auth-complete',
    authUrl: 'https://idm.stackspot.com/zup/oidc/auth',
    tokenUrl: 'https://idm.stackspot.com/zup/oidc/token'
};

let authorizationCode = null;

// Função para gerar um estado aleatório
function generateState() {
    return crypto.randomBytes(32).toString('hex');
}

// Função para gerar um code_verifier e code_challenge
function generatePKCEPair() {
    const verifier = crypto.randomBytes(32).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    return { verifier, challenge };
}

// Função para iniciar o fluxo de autenticação
async function startAuthFlow(email) {
    console.log('Iniciando fluxo de autenticação');
    const state = generateState();
    const { verifier, challenge } = generatePKCEPair();

    const authUrl = `${config.authUrl}?state=${state}&client_id=${config.clientId}&redirect_uri=${encodeURIComponent(config.redirectUri)}&response_type=code&scope=openid email offline_access profile attributes roles&code_challenge=${challenge}&code_challenge_method=S256&login_hint=${email}`;

    console.log('URL de autenticação gerada:', authUrl);

    try {
        const open = await import('open');
        console.log('Abrindo navegador para autenticação');

        await open.default(authUrl);
        console.log('Navegador aberto. Aguardando autenticação...');

        const code = await waitForAuthorizationCode();
        console.log('Código de autorização obtido:', code);

        return { code, verifier };
    } catch (error) {
        console.error('Erro no fluxo de autenticação:', error);
        throw error;
    }
}

function waitForAuthorizationCode() {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            reject(new Error('Tempo limite de autenticação excedido'));
        }, 300000); // 5 minutos de timeout

        vscode.window.registerUriHandler({
            handleUri(uri) {
                console.log('URI de redirecionamento recebida:', uri.toString());
                const query = querystring.parse(uri.query);
                if (query.code) {
                    clearTimeout(timeoutId);
                    console.log('Código de autorização recebido');
                    resolve(query.code);
                } else if (query.error) {
                    console.error('Erro na autenticação:', query.error);
                    vscode.window.showErrorMessage(`Erro na autenticação: ${query.error}`);
                    reject(new Error(query.error));
                }
            }
        });
    });
}

// Função para trocar o código de autorização pelo token de acesso
async function exchangeCodeForToken(code, codeVerifier) {
    console.log('Trocando código de autorização por token');
    const postData = querystring.stringify({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        redirect_uri: config.redirectUri,
        code: code,
        code_verifier: codeVerifier
    });

    const options = {
        hostname: 'idm.stackspot.com',
        path: '/zup/oidc/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': postData.length
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    const response = JSON.parse(data);
                    console.log('Token de acesso obtido com sucesso');
                    resolve(response.access_token);
                } else {
                    console.error('Falha ao obter token:', res.statusCode, res.statusMessage);
                    reject(new Error(`Failed to get token: ${res.statusCode} ${res.statusMessage}`));
                }
            });
        });

        req.on('error', error => {
            console.error('Erro na requisição de token:', error);
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

// Função para enviar mensagem ao StackSpot AI
async function sendMessageToStackSpotAI(token, message) {
    const projectId = getProjectIdFromWorkspace() || "default-project-id";

    const postData = JSON.stringify({
        user_prompt: message,
        project_id: projectId
    });

    const options = {
        hostname: 'genai-code-buddy-api.stackspot.com',
        path: '/v3/chat',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Content-Length': postData.length,
            'x-platform': 'VSCode',
            'x-platform-version': '1.0.0',
            'x-stackspot-ai-version': '1.0.0',
            'x-os': process.platform
        }
    };

    return new Promise((resolve, reject) => {
        const req = https.request(options, res => {
            let data = '';

            res.on('data', chunk => {
                data += chunk;
            });

            res.on('end', () => {
                if (res.statusCode === 200) {
                    const response = JSON.parse(data);
                    resolve(response.answer);
                } else {
                    reject(new Error(`Failed to send message: ${res.statusCode} ${res.statusMessage}`));
                }
            });
        });

        req.on('error', error => {
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

// Função para obter o project_id a partir do workspace do VS Code
function getProjectIdFromWorkspace() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders) {
        const workspacePath = workspaceFolders[0].uri.fsPath;
        return `project-${workspacePath}`; // Gera um project_id baseado no caminho do workspace
    }
    return null;
}

// Função principal para resolver issues do SonarCloud
async function resolveSonarIssues(lastUsedBranch) {
    console.log('Iniciando resolução de issues do SonarCloud');

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('Nenhum arquivo aberto para resolver issues.');
        return lastUsedBranch;
    }

    try {
        // Adicionar comentários do SonarCloud
        // await addSonarCommentsToFile(lastUsedBranch);

        // Solicitar o e-mail do usuário
        /*
        const email = await vscode.window.showInputBox({
            prompt: 'Por favor, insira seu e-mail StackSpot',
            placeHolder: 'seu-email@exemplo.com',
            validateInput: (value) => {
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : 'Por favor, insira um e-mail válido';
            }
        });

        if (!email) {
            vscode.window.showErrorMessage('E-mail não fornecido. Autenticação cancelada.');
            return lastUsedBranch;
        }
        */
        email = "thiago.fialho@zup.com.br";

        console.log('Iniciando fluxo de autenticação');
        // Iniciar o fluxo de autenticação com o e-mail fornecido
        const { code, verifier } = await startAuthFlow(email);
        console.log('Código de autorização obtido');

        // Trocar o código de autorização por um token de acesso
        const token = await exchangeCodeForToken(code, verifier);
        console.log('Token de acesso obtido');

        // Obter o conteúdo do arquivo atual
        const document = editor.document;
        const fileContent = document.getText();

        // Criar a mensagem para o StackSpot AI
        const message = `Analyze and fix the following code for SonarCloud issues:\n\n${fileContent}`;

        console.log('Enviando mensagem para StackSpot AI');
        // Enviar mensagem para o StackSpot AI
        const aiResponse = await sendMessageToStackSpotAI(token, message);

        if (aiResponse) {
            console.log('Resposta do StackSpot AI recebida');
            // Substituir o conteúdo do arquivo com a resposta do AI
            const edit = new vscode.WorkspaceEdit();
            edit.replace(
                document.uri,
                new vscode.Range(
                    document.positionAt(0),
                    document.positionAt(document.getText().length)
                ),
                aiResponse
            );
            await vscode.workspace.applyEdit(edit);

            vscode.window.showInformationMessage('SonarCloud issues resolved successfully.');
        } else {
            vscode.window.showErrorMessage('Failed to resolve SonarCloud issues.');
        }

    } catch (error) {
        console.error('Erro ao resolver issues do SonarCloud:', error);
        vscode.window.showErrorMessage(`Erro ao resolver issues do SonarCloud: ${error.message}`);
    }

    return lastUsedBranch;
}

module.exports = {
    resolveSonarIssues
};