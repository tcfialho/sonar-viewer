const vscode = require('vscode');
const { execSync } = require('child_process');

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

async function getAccessToken() {
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

module.exports = {
    getCurrentGitBranch,
    getProjectIdFromConfig,
    getAccessToken
};