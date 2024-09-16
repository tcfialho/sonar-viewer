const vscode = require('vscode');
const { execSync } = require('child_process');
const https = require('https');

let cachedToken = null;
let tokenExpirationTime = null;

function getCurrentGitBranch() {
    try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: vscode.workspace.rootPath })
            .toString()
            .trim();

        return branch || 'master';
    } catch (error) {
        console.error('Erro ao obter a branch Git atual:', error);
        return 'master';
    }
}

async function getProjectIdFromConfig() {
    try {
        const repoName = execSync('git rev-parse --show-toplevel', { cwd: vscode.workspace.rootPath })
            .toString()
            .trim()
            .split('/')
            .pop();

        if (repoName) {
            console.log(`Nome do repositório obtido: ${repoName}`);
            return repoName;
        }
    } catch (error) {
        console.error('Erro ao obter o nome do repositório:', error);
    }

    const projectId = await vscode.window.showInputBox({
        prompt: 'Digite o ID do projeto SonarCloud',
        placeHolder: 'Ex: meu-projeto-api'
    });

    if (projectId) {
        const config = vscode.workspace.getConfiguration('sonarCloudViewer');
        await config.update('projectId', projectId, vscode.ConfigurationTarget.Workspace);
    }

    return projectId;
}

async function getSonarCloudAccessToken() {
    const config = vscode.workspace.getConfiguration('sonarCloudViewer');
    let token = config.get('accessToken');

    if (!token) {
        token = await vscode.window.showInputBox({
            prompt: 'Digite seu token de acesso do SonarCloud',
            password: true
        });

        if (token) {
            await config.update('accessToken', token, vscode.ConfigurationTarget.Global);
        }
    }

    return token;
}

async function getStackSpotClientId() {
    const config = vscode.workspace.getConfiguration('sonarCloudViewer');
    let clientId = config.get('stackSpotClientId');

    if (!clientId) {
        clientId = await vscode.window.showInputBox({
            prompt: 'Digite o StackSpot Client ID',
            placeHolder: 'Ex: your-client-id'
        });

        if (clientId) {
            await config.update('stackSpotClientId', clientId, vscode.ConfigurationTarget.Global);
        }
    }

    return clientId;
}

async function getStackSpotClientSecret() {
    const config = vscode.workspace.getConfiguration('sonarCloudViewer');
    let clientSecret = config.get('stackSpotClientSecret');

    if (!clientSecret) {
        clientSecret = await vscode.window.showInputBox({
            prompt: 'Digite o StackSpot Client Secret',
            password: true
        });

        if (clientSecret) {
            await config.update('stackSpotClientSecret', clientSecret, vscode.ConfigurationTarget.Global);
        }
    }

    return clientSecret;
}

async function fetchIssues(projectId, branch, token) {
    const issuesUrl = `https://sonarcloud.io/api/issues/search?componentKeys=${projectId}&branch=${branch}&ps=500&additionalFields=_all&statuses=OPEN`;
    const options = { headers: { 'Authorization': `Bearer ${token}` } };

    return new Promise((resolve, reject) => {
        https.get(issuesUrl, options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`Erro ao buscar issues: ${res.statusCode} ${res.statusMessage}`));
                } else {
                    try {
                        const issuesData = JSON.parse(data);
                        resolve(issuesData.issues || []);
                    } catch (error) {
                        reject(new Error('Erro ao parsear dados das issues'));
                    }
                }
            });
        }).on('error', (err) => reject(new Error(`Erro de rede: ${err.message}`)));
    });
}

function groupIssuesByFile(issues) {
    return issues.reduce((acc, issue) => {
        const componentKey = issue.component;
        acc[componentKey] = acc[componentKey] || [];
        acc[componentKey].push(issue);
        return acc;
    }, {});
}

async function fetchSourceForFiles(projectId, branch, token, fileKeys) {
    const filesWithSource = {};
    const fetchPromises = fileKeys.map(async (fileKey) => {
        const sourceUrl = `https://sonarcloud.io/api/sources/raw?key=${fileKey}&branch=${branch}`;
        const options = { headers: { 'Authorization': `Bearer ${token}` } };

        try {
            const sourceCode = await new Promise((resolve, reject) => {
                https.get(sourceUrl, options, (res) => {
                    let data = '';
                    res.on('data', (chunk) => { data += chunk; });
                    res.on('end', () => {
                        if (res.statusCode !== 200) {
                            reject(new Error(`Erro ao buscar código-fonte para ${fileKey}: ${res.statusCode} ${res.statusMessage}`));
                        } else {
                            resolve(data);
                        }
                    });
                }).on('error', (err) => reject(new Error(`Erro de rede: ${err.message}`)));
            });
            filesWithSource[fileKey] = sourceCode.split('\n');
        } catch (error) {
            filesWithSource[fileKey] = ['Código-fonte não disponível'];
        }
    });

    await Promise.all(fetchPromises);
    return filesWithSource;
}

async function getClientCredentialsToken(clientId, clientSecret) {
    if (cachedToken && tokenExpirationTime && Date.now() < tokenExpirationTime) {
        console.log('Using cached token');
        return cachedToken;
    }

    console.log('Obtaining new token using client credentials');
    const postData = `client_id=${encodeURIComponent(clientId)}&grant_type=client_credentials&client_secret=${encodeURIComponent(clientSecret)}`;

    const options = {
        hostname: 'idm.stackspot.com',
        path: '/zup/oidc/oauth/token',
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'Mozilla/5.0'
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
                    console.log('Access token obtained successfully');
                    cachedToken = response.access_token;
                    // Assuming the token expires in 1 hour (3600 seconds)
                    tokenExpirationTime = Date.now() + (response.expires_in || 3600) * 1000;
                    resolve(cachedToken);
                } else {
                    console.error('Failed to obtain token:', res.statusCode, res.statusMessage);
                    reject(new Error(`Failed to obtain token: ${res.statusCode} ${res.statusMessage}`));
                }
            });
        });

        req.on('error', error => {
            console.error('Error in token request:', error);
            reject(error);
        });

        req.write(postData);
        req.end();
    });
}

async function executeRemoteQuickCommand(token, fileContent, conversationId = null) {
    const postData = JSON.stringify({
        input_data: fileContent
    });

    let path = '/v1/quick-commands/create-execution/fix-sonar-issues-remote';
    if (conversationId) {
        path += `?conversation_id=${conversationId}`;
    }

    const options = {
        hostname: 'genai-code-buddy-api.stackspot.com',
        path: path,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0',
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
                    // Remove aspas extras e espaços em branco
                    const cleanedData = data.trim().replace(/^"|"$/g, '');
                    resolve(cleanedData);
                } else {
                    reject(new Error(`Failed to execute quick command: ${res.statusCode} ${res.statusMessage}`));
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

async function getQuickCommandResult(token, executionId) {
    const options = {
        hostname: 'genai-code-buddy-api.stackspot.com',
        path: `/v1/quick-commands/callback/${executionId}`,
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'Mozilla/5.0'
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
                    if (response.progress.status === 'COMPLETED') {
                        resolve(response);
                    } else {
                        resolve(null); // Not completed yet
                    }
                } else {
                    reject(new Error(`Failed to get quick command result: ${res.statusCode} ${res.statusMessage}`));
                }
            });
        });

        req.on('error', error => {
            reject(error);
        });

        req.end();
    });
}

function extractCodeBlock(result) {
    if (typeof result === 'string') {
      const codeBlockRegex = /```[\s\S]*?\n([\s\S]*?)```/;
      const match = result.match(codeBlockRegex);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
    return result; // Return original result if no code block is found or if result is not a string
}

module.exports = {
    getCurrentGitBranch,
    getProjectIdFromConfig,
    getSonarCloudAccessToken,
    getStackSpotClientId,
    getStackSpotClientSecret,
    fetchIssues,
    groupIssuesByFile,
    fetchSourceForFiles,
    getClientCredentialsToken,
    executeRemoteQuickCommand,
    getQuickCommandResult,
    extractCodeBlock
};