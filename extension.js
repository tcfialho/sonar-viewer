const vscode = require('vscode');
const sonarCloudViewer = require('./sonarCloudViewer');
const sonarComments = require('./sonarCloudComments');
const { resolveSonarIssues } = require('./sonarCloudResolveIssues');

let lastUsedBranch = 'master'; // Branch padrão

function activate(context) {
    console.log('Extensão SonarCloudViewer ativada');

    let showSonarCloudViewerDisposable = vscode.commands.registerCommand('sonar.viewer.showSonarCloudViewer', async () => {
        lastUsedBranch = await sonarCloudViewer.showSonarCloudViewer(context, lastUsedBranch);
    });

    let addSonarCommentsToFileDisposable = vscode.commands.registerCommand('sonar.viewer.addSonarCommentsToFile', async () => {
        lastUsedBranch = await sonarComments.addSonarCommentsToFile(lastUsedBranch);
    });

    let resolveIssuesDisposable = vscode.commands.registerCommand('sonar.viewer.resolveSonarIssues', async () => {
        lastUsedBranch = await resolveSonarIssues(lastUsedBranch);
    });
    
    context.subscriptions.push(showSonarCloudViewerDisposable, addSonarCommentsToFileDisposable, resolveIssuesDisposable);
}

function deactivate() {
    console.log('Extensão SonarCloudViewer desativada');
}

module.exports = {
    activate,
    deactivate
};