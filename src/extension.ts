import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "zeta-note-vscode" is now active!');

	let restartServerCmd = vscode.commands.registerCommand('zeta-note-vscode.restartServer', async () => {
		await client.stop();
		client.start();
		vscode.window.showInformationMessage('Zeta Note server has been restarted');
	});
	context.subscriptions.push(restartServerCmd);

	let clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: "file", language: "markdown" }]
	};

	let serverOptions: ServerOptions = {
		command: "cargo",
		args: ["run"],
		options: {
			cwd: "/Users/arr/dev/zeta-note"
		}
	};
	client = new LanguageClient("zeta-note", "Zeta Note", serverOptions, clientOptions, true);
	client.start();
}

export function deactivate() {
	if (!client) {
		return undefined;
	}

	return client.stop();
}
