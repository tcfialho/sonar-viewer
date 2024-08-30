# SonarCloud Viewer for VS Code

## Overview

SonarCloud Viewer is a Visual Studio Code extension that allows you to view SonarCloud issues directly within your VS Code environment. It provides an easy way to monitor and manage code quality issues identified by SonarCloud without leaving your development environment.

## Features

- View SonarCloud issues for your project directly in VS Code
- Automatically updates the view every 5 minutes
- Supports custom project ID configuration

## Requirements

- Visual Studio Code 1.92.0 or higher
- An active SonarCloud account and project

## Installation

1. Download the `.vsix` file from the releases page.
2. In VS Code, go to the Extensions view (Ctrl+Shift+X).
3. Click on the "..." at the top of the Extensions view and select "Install from VSIX...".
4. Choose the downloaded `.vsix` file.

## Usage

1. Open a project that is connected to SonarCloud.
2. Create a `sonarcloudviewer.json` file in the root of your project with the following content:
   ```json
   {
     "projectId": "your-sonarcloud-project-id"
   }
   ```
   Replace `your-sonarcloud-project-id` with your actual SonarCloud project ID.
3. If you don't provide a `sonarcloudviewer.json` file, the extension will use the name of your current folder (in lowercase) as the project ID.
4. Open the Command Palette (Ctrl+Shift+P) and run the command "Show SonarCloud Viewer".
5. A new panel will open displaying the SonarCloud issues for your project.

## Configuration

You can configure the project ID by creating a `sonarcloudviewer.json` file in the root of your project. The file should have the following structure:

```json
{
  "projectId": "your-sonarcloud-project-id"
}
```

## Known Issues

[List any known issues or limitations here]

## Release Notes

### 0.0.1

Initial release of SonarCloud Viewer

---

## For more information

* [SonarCloud Documentation](https://docs.sonarcloud.io/)
* [Visual Studio Code's Markdown Support](http://code.visualstudio.com/docs/languages/markdown)

**Enjoy!**