const vscode = require('vscode');
const { execSync } = require('child_process');
const axios = require('axios');

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

async function getStackSpotClientKey() {
    const config = vscode.workspace.getConfiguration('sonarCloudViewer');
    let clientSecret = config.get('stackSpotClientKey');

    if (!clientSecret) {
        clientSecret = await vscode.window.showInputBox({
            prompt: 'Digite o StackSpot Client Key',
            password: true
        });

        if (clientSecret) {
            await config.update('stackSpotClientKey', clientSecret, vscode.ConfigurationTarget.Global);
        }
    }

    return clientSecret;
}

async function fetchIssues(projectId, branch, token) {
    const issuesUrl = `https://sonarcloud.io/api/issues/search?componentKeys=${projectId}&branch=${branch}&ps=500&additionalFields=_all&statuses=OPEN`;
    
    try {
        const response = await axios.get(issuesUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        return response.data.issues || [];
    } catch (error) {
        console.error('Erro ao buscar issues:', error.message);
        throw new Error(`Erro ao buscar issues: ${error.response?.status} ${error.response?.statusText}`);
    }
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
        
        try {
            const response = await axios.get(sourceUrl, {
                headers: { 'Authorization': `Bearer ${token}` }
            });
            filesWithSource[fileKey] = response.data.split('\n');
        } catch (error) {
            console.error(`Erro ao buscar código-fonte para ${fileKey}:`, error.message);
            filesWithSource[fileKey] = ['Código-fonte não disponível'];
        }
    });

    await Promise.all(fetchPromises);
    return filesWithSource;
}

async function getStackSpotRealm() {
    const config = vscode.workspace.getConfiguration('sonarCloudViewer');
    let realm = config.get('stackSpotRealm');

    if (!realm) {
        realm = await vscode.window.showInputBox({
            prompt: 'Digite o StackSpot Realm',
            placeHolder: 'Ex: zup, localiza'
        });

        if (realm) {
            await config.update('stackSpotRealm', realm, vscode.ConfigurationTarget.Global);
        }
    }

    return realm;
}

async function getClientCredentialsToken(clientId, clientSecret) {
    if (cachedToken && tokenExpirationTime && Date.now() < tokenExpirationTime) {
        console.log('Using cached token');
        return cachedToken;
    }

    console.log('Obtaining new token using client credentials');
    const realm = await getStackSpotRealm();
    const tokenUrl = `https://idm.stackspot.com/${realm}/oidc/oauth/token`;
    const postData = `client_id=${encodeURIComponent(clientId)}&grant_type=client_credentials&client_secret=${encodeURIComponent(clientSecret)}`;

    try {
        const response = await axios.post(tokenUrl, postData, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': 'Mozilla/5.0'
            }
        });

        console.log('Access token obtained successfully');
        cachedToken = response.data.access_token;
        tokenExpirationTime = Date.now() + (response.data.expires_in || 3600) * 1000;
        return cachedToken;
    } catch (error) {
        console.error('Failed to obtain token:', error.message);
        throw new Error(`Failed to obtain token: ${error.response?.status} ${error.response?.statusText}`);
    }
}

async function executeRemoteQuickCommand(token, fileContent, conversationId = null) {
    let url = 'https://genai-code-buddy-api.stackspot.com/v1/quick-commands/create-execution/stk-fix-sonar-issues-remote';
    if (conversationId) {
        url += `?conversation_id=${conversationId}`;
    }

    try {
        const response = await axios.post(url, { input_data: fileContent }, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0'
            }
        });
        return response.data.trim().replace(/^"|"$/g, '');
    } catch (error) {
        console.error('Failed to execute quick command:', error.message);
        throw new Error(`Failed to execute quick command: ${error.response?.status} ${error.response?.statusText}`);
    }
}

async function getQuickCommandResult(token, executionId) {
    try {
        const response = await axios.get(`https://genai-code-buddy-api.stackspot.com/v1/quick-commands/callback/${executionId}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (response.data.progress.status === 'COMPLETED') {
            return response.data;
        }
        return null; // Not completed yet
    } catch (error) {
        console.error('Failed to get quick command result:', error.message);
        throw new Error(`Failed to get quick command result: ${error.response?.status} ${error.response?.statusText}`);
    }
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
    getStackSpotClientKey,
    getStackSpotRealm,
    fetchIssues,
    groupIssuesByFile,
    fetchSourceForFiles,
    getClientCredentialsToken,
    executeRemoteQuickCommand,
    getQuickCommandResult,
    extractCodeBlock
};