import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, NotificationType, ServerOptions } from 'vscode-languageclient/node';

import * as os from 'os';
import * as path from 'path';

let client: LanguageClient;
let statusBarItem: vscode.StatusBarItem;

type StatusParams = {
	ok: boolean,
	notes: number
};

const statusNotificationType = new NotificationType<StatusParams>("zeta-note/status");

export function activate(context: vscode.ExtensionContext) {
	console.log('Congratulations, your extension "zeta-note-vscode" is now active!');

	let restartServerCmd = vscode.commands.registerCommand('zeta-note-vscode.restartServer', async () => {
		stopClient(client);
		resetStatus();

		client = new LanguageClient("zeta-note", "Zeta Note", serverOptions, clientOptions, true);
		configureClient(client);
		context.subscriptions.push(client.start());
	});
	context.subscriptions.push(restartServerCmd);

	let showOutputCmd = vscode.commands.registerCommand('zeta-note-vscode.showOutputChannel', () => {
		if (client) {
			let outputchannel = client.outputChannel;
			outputchannel.show(true);
		}
	});
	context.subscriptions.push(showOutputCmd);

	let clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: "file", language: "markdown" }]
	};

	let homeDir = os.homedir();
	let zetaNoteServer = path.join(homeDir, 'dev', 'zeta-note');

	let serverOptions: ServerOptions = {
		command: "cargo",
		args: ["run"],
		options: {
			cwd: zetaNoteServer
		}
	};
	client = new LanguageClient("zeta-note", "Zeta Note", serverOptions, clientOptions, true);
	configureClient(client);

	createDefaultStatusBarItem();

	context.subscriptions.push(
		client.start(),
		restartServerCmd,
		showOutputCmd,
	);
}

function configureClient(client: LanguageClient) {
	client.onReady().then(() => {
		console.log("Client onReady");

		client.onNotification(statusNotificationType, (statusParams) => {
			console.log("Got zeta-note/status notification");
			updateStatus(statusParams);
		});
	});
}

function createDefaultStatusBarItem() {
	statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
	statusBarItem.command = 'zeta-note-vscode.showOutputChannel';
	resetStatus();
	statusBarItem.show();
}

function updateStatus(statusParams: StatusParams) {
	let status = statusParams.ok ? `✓ ZN (${statusParams.notes})` : '☠️ ZN';
	statusBarItem.text = status;
}

function resetStatus() {
	statusBarItem.text = "? ZN";
}

async function stopClient(client: LanguageClient) {
	if (client) {
		await client.stop();
		client.outputChannel.dispose();
		client.traceOutputChannel.dispose();
	}
}

export async function deactivate() {
	await stopClient(client);

	if (statusBarItem) {
		statusBarItem.hide();
	}
}
