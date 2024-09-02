const vscode = require('vscode');
const sonarCloudViewer = require('./sonarCloudViewer');
const sonarComments = require('./sonarCloudComments');

let lastUsedBranch = 'master'; // Branch padrão

function activate(context) {
    console.log('Extensão SonarCloudViewer ativada');

    let disposable = vscode.commands.registerCommand('sonar-viewer.showSonarCloudViewer', async () => {
        lastUsedBranch = await sonarCloudViewer.showSonarCloudViewer(context, lastUsedBranch);
    });

    let addCommentsDisposable = vscode.commands.registerCommand('sonar-viewer.addSonarCommentsToFile', async () => {
        lastUsedBranch = await sonarComments.addSonarCommentsToFile(lastUsedBranch);
    });

    context.subscriptions.push(disposable, addCommentsDisposable);
}

function deactivate() {
    console.log('Extensão SonarCloudViewer desativada');
}

module.exports = {
    activate,
    deactivate
};