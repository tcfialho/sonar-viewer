const vscode = require('vscode');
const { 
    getCurrentGitBranch, 
    getProjectIdFromConfig, 
    getAccessToken, 
    getStackSpotClientId, 
    getStackSpotClientSecret,
    getClientCredentialsToken,
    executeRemoteQuickCommand,
    getQuickCommandResult,
    extractCodeBlock
} = require('./utils');

// Configuration for the application
let config = {
    clientId: '',
    clientSecret: '',
    tokenUrl: 'https://idm.stackspot.com/zup/oidc/oauth/token'
};

async function initializeConfig() {
    config.clientId = await getStackSpotClientId();
    config.clientSecret = await getStackSpotClientSecret();
}

// Function to resolve SonarCloud issues
async function resolveCommentedSonarIssuesInCurrentFile(lastUsedBranch) {
    console.log('Starting SonarCloud issue resolution');

    const steps = [
        "Iniciando resolução de problemas",
        "Obtendo token de acesso",
        "Executando comando remoto",
        "Aguardando resultado",
        "Aplicando mudanças"
    ];
    
    const totalSteps = steps.length;

    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No file open to resolve issues.');
        return lastUsedBranch;
    }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Resolvendo problemas do SonarCloud",
        cancellable: false
    }, async (progress) => {
        try {
            let currentStep = 0;
            const incrementProgress = (message) => {
                currentStep++;
                progress.report({ increment: (100 / totalSteps), message });
            };

            incrementProgress(steps[0]);

            incrementProgress(steps[1]);
            console.log('Obtaining access token');
            await initializeConfig();
            const token = await getClientCredentialsToken(config.clientId, config.clientSecret);
            console.log('Access token obtained');

            const document = editor.document;
            const fileContent = document.getText();

            incrementProgress(steps[2]);
            console.log('Executing remote quick command');
            const executionId = await executeRemoteQuickCommand(token, fileContent);
            console.log(`Remote quick command execution started with ID: ${executionId}`);

            incrementProgress(steps[3]);
            let result = null;
            let attempts = 0;
            const maxAttempts = 30; // 5 minutes timeout (10 seconds * 30 attempts)

            while (!result && attempts < maxAttempts) {
                await new Promise(resolve => setTimeout(resolve, 10000)); // Wait for 10 seconds
                result = await getQuickCommandResult(token, executionId);
                attempts++;
                progress.report({ message: `${steps[3]} (tentativa ${attempts})` });
            }

            if (result && result.progress.status === 'COMPLETED') {
                incrementProgress(steps[4]);
                console.log('Remote quick command result received');
                const resolvedContent = extractCodeBlock(result.result);
                const edit = new vscode.WorkspaceEdit();
                edit.replace(
                    document.uri,
                    new vscode.Range(
                        document.positionAt(0),
                        document.positionAt(document.getText().length)
                    ),
                    resolvedContent
                );
                await vscode.workspace.applyEdit(edit);

                vscode.window.showInformationMessage('SonarCloud issues resolved successfully.');
            } else {
                throw new Error('Failed to resolve SonarCloud issues. Timeout or execution failed.');
            }

        } catch (error) {
            console.error('Error resolving SonarCloud issues:', error);
            vscode.window.showErrorMessage(`Error resolving SonarCloud issues: ${error.message}`);
        }
    });

    return lastUsedBranch;
}

module.exports = {
    resolveCommentedSonarIssuesInCurrentFile
};