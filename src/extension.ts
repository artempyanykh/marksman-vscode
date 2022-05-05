import * as vscode from 'vscode';
import {
	ExecutableOptions,
	URI,
	StaticFeature,
	Position,
	LanguageClient,
	LanguageClientOptions,
	NotificationType,
	ServerOptions,
	State,
	Location,
	ClientCapabilities,
	DocumentSelector,
	ServerCapabilities
} from 'vscode-languageclient/node';

import * as os from 'os';
import * as which from 'which';
import * as fs from 'fs';

import fetch from 'node-fetch';
import * as stream from 'stream';
import { promisify } from 'util';

let client: LanguageClient | null;
let statusBarItem: vscode.StatusBarItem;

type RunState = "init" | "dead" | "ok";

type StatusParams = {
	state: RunState,
	docCount: number
};
const defaultStatus: StatusParams = { state: "init", docCount: 0 };
const deadStatus: StatusParams = { state: "dead", docCount: 0 };

const extId = "marksman";
const extName = "Marksman";
const compatibleServerRelease = "2021-08-11";
const releaseBaseUrl = "https://github.com/artempyanykh/marksman/releases/download";

const statusNotificationType = new NotificationType<StatusParams>("marksman/status");

type ShowReferencesData = {
	uri: URI,
	position: Position,
	locations: Location[]
};

type FollowLinkData = {
	from: Location,
	to: Location,
};

type ExperimentalCapabilities = {
	codeLensShowReferences?: boolean,
	followLinks?: boolean
	statusNotification?: boolean
};

class ExperimentalFeatures implements StaticFeature {
	fillClientCapabilities(capabilities: ClientCapabilities): void {
		const experimental: ExperimentalCapabilities = capabilities.experimental ?? {};
		experimental.codeLensShowReferences = true;
		experimental.followLinks = true;
		experimental.statusNotification = true;

		capabilities.experimental = experimental;
	}

	initialize(_capabilities: ServerCapabilities<any>, _documentSelector: DocumentSelector | undefined): void {
	}

	dispose(): void {
	}

}

export async function activate(context: vscode.ExtensionContext) {
	// Create a status
	statusBarItem = createDefaultStatus();
	statusBarItem.show();

	client = await connectToServer(context, statusBarItem);

	// Setup commands
	let restartServerCmd = vscode.commands.registerCommand(`${extId}.restartServer`, async () => {
		stopClient(client);
		updateStatus(statusBarItem, defaultStatus);

		client = await connectToServer(context, statusBarItem);
		if (client) {
			context.subscriptions.push(client.start());
		}
	});
	let showOutputCmd = vscode.commands.registerCommand(`${extId}.showOutputChannel`, () => {
		if (client) {
			let outputchannel = client.outputChannel;
			outputchannel.show(true);
		}
	});
	let showReferencesCmd = vscode.commands.registerCommand(`${extId}.showReferences`, async (data: ShowReferencesData) => {
		if (client) {
			await vscode.commands.executeCommand(
				'editor.action.showReferences',
				vscode.Uri.parse(data.uri),
				client.protocol2CodeConverter.asPosition(data.position),
				data.locations.map(client.protocol2CodeConverter.asLocation),
			);
		}
	});
	let followLinkCmd = vscode.commands.registerCommand(`${extId}.followLink`, async (data: FollowLinkData) => {
		if (client) {
			const fromLoc = client.protocol2CodeConverter.asLocation(data.from);
			const toLoc = client.protocol2CodeConverter.asLocation(data.to);
			await vscode.commands.executeCommand(
				'editor.action.goToLocations',
				fromLoc.uri,
				fromLoc.range.start,
				[toLoc],
				"goto",
				"Couldn't locate the target of the link"

			);
		}
	});

	if (client) {
		context.subscriptions.push(client.start());
	}
	context.subscriptions.push(
		restartServerCmd,
		showOutputCmd,
		showReferencesCmd,
		followLinkCmd
	);
}

async function connectToServer(context: vscode.ExtensionContext, status: vscode.StatusBarItem): Promise<LanguageClient | null> {
	// Try to find the server binary and create ServerOptions
	// Return early if no binary can be found
	let serverOptions: ServerOptions;
	let maybeServerOptions: ServerOptions | null = await mkServerOptions(context);
	if (maybeServerOptions === null) {
		console.error(`Couldn't find ${serverBinName()} server binary`);
		updateStatus(status, deadStatus);
		return null;
	} else {
		serverOptions = maybeServerOptions;
	}

	// Init LS client
	let clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: "file", language: "markdown" }]
	};

	return createClient(serverOptions, clientOptions);
}

async function mkServerOptions(context: vscode.ExtensionContext): Promise<ServerOptions | null> {
	let fromConfig = mkServerOptionsFromConfig();
	if (fromConfig) {
		return fromConfig;
	}

	let binInPath = await findServerInPath();
	if (binInPath) {
		return {
			command: binInPath,
		};
	}

	return await downloadServerFromGH(context);
}

function mkServerOptionsFromConfig(): ServerOptions | null {
	let extConf = vscode.workspace.getConfiguration(`${extId}`);
	let customCommand = extConf.get<string>('customCommand');
	let customCommandDir = extConf.get<string>('customCommandDir');
	if (customCommand) {
		let [command, ...args] = customCommand.split(" ");
		let options: ExecutableOptions = {};
		if (customCommandDir) {
			options = { cwd: customCommandDir };
		}

		return {
			command: command,
			args: args,
			options: options
		};
	} else {
		return null;
	}
}

function serverBinName(): string {
	let platform = os.platform();
	if (platform === 'win32') {
		return 'marksman.exe';
	} else if (platform === 'darwin' || platform === 'linux') {
		return 'marksman';
	} else {
		throw new Error(`Unsupported platform: ${platform}`);
	}
}

function releaseBinName(): string {
	const platform = os.platform();

	if (platform === 'win32') {
		return 'marksman-windows.exe';
	} else if (platform === 'darwin') {
		return 'marksman-macos';
	} else if (platform === 'linux') {
		return 'marksman-linux';
	} else {
		throw new Error(`Unsupported platform: ${platform}`);
	}
}

function releaseDownloadUrl(): string {
	return releaseBaseUrl + "/" + compatibleServerRelease + "/" + releaseBinName();
}

async function downloadRelease(targetDir: vscode.Uri, onProgress: (progress: number) => void): Promise<void> {
	const targetFile = vscode.Uri.joinPath(targetDir, serverBinName());
	const tempName = (Math.round(Math.random() * 100) + 1).toString();
	const tempFile = vscode.Uri.joinPath(targetDir, tempName);
	const downloadUrl = releaseDownloadUrl();

	console.log(`Downloading from ${downloadUrl}; destination file ${tempFile.fsPath}`);
	const resp = await fetch(downloadUrl);

	if (!resp.ok) {
		console.error("Couldn't download the server binary");
		console.error({ body: await resp.text() });
		return;
	}

	const contentLength = resp.headers.get('content-length');
	if (contentLength === null || Number.isNaN(contentLength)) {
		console.error(`Unexpected content-length: ${contentLength}`);
		return;
	}
	let totalBytes = Number.parseInt(contentLength);
	console.log(`The size of the binary is ${totalBytes} bytes`);

	let currentBytes = 0;
	let reportedPercent = 0;
	resp.body.on('data', (chunk) => {
		currentBytes = currentBytes + chunk.length;
		let currentPercent = Math.floor(currentBytes / totalBytes * 100);
		if (currentPercent > reportedPercent) {
			onProgress(currentPercent);
			reportedPercent = currentPercent;
		}
	});

	const destStream = fs.createWriteStream(tempFile.fsPath);
	const downloadProcess = promisify(stream.pipeline);
	await downloadProcess(resp.body, destStream);

	console.log(`Downloaded the binary to ${tempFile.fsPath}`);
	await vscode.workspace.fs.rename(tempFile, targetFile);
	await fs.promises.chmod(targetFile.fsPath, 0o755);
}

async function downloadServerFromGH(context: vscode.ExtensionContext): Promise<ServerOptions | null> {
	const targetDir = vscode.Uri.joinPath(context.globalStorageUri, compatibleServerRelease);
	await vscode.workspace.fs.createDirectory(targetDir);
	const targetFile = vscode.Uri.joinPath(targetDir, serverBinName());

	let serverPath;

	try {
		await vscode.workspace.fs.stat(targetFile);
		console.log("marksman binary is already downloaded");
	} catch {
		// The file doesn't exist. Continue to download
		await vscode.window.withProgress({
			cancellable: false,
			title: `Downloading marksman ${compatibleServerRelease} from GH`,
			location: vscode.ProgressLocation.Notification
		}, async (progress, _cancellationToken) => {
			let lastPercent = 0;
			const serverPath = await downloadRelease(targetDir, (percent) => {
				progress.report({ message: `${percent}%`, increment: percent - lastPercent });
				lastPercent = percent;
			});
		});
	}

	serverPath = targetFile.fsPath;
	try {
		await vscode.workspace.fs.stat(targetFile);
		return {
			command: serverPath
		};
	} catch {
		console.error("Failed to download marksman server binary");
		return null;
	}

}

async function findServerInPath(): Promise<string | null> {
	let binName = serverBinName();
	let inPath = new Promise<string>((resolve, reject) => {
		which(binName, (err, path) => {
			if (err) {
				reject(err);
			}
			if (path === undefined) {
				reject(new Error('which return undefined path'));
			} else {
				resolve(path);
			}
		});
	});

	let resolved = await inPath.catch((_) => null);
	return resolved;
}

function createClient(serverOptions: ServerOptions, clientOptions: LanguageClientOptions): LanguageClient {
	let client = new LanguageClient(extId, extName, serverOptions, clientOptions);
	configureClient(client);
	return client;
}

function configureClient(client: LanguageClient) {
	client.registerFeature(new ExperimentalFeatures());

	client.onReady().then(() => {
		console.log('Client onReady');

		client.onNotification(statusNotificationType, (statusParams) => {
			console.log('Got marksman/status notification');
			updateStatus(statusBarItem, statusParams);
		});
	});
	client.onDidChangeState((ev) => {
		if (ev.newState === State.Stopped) {
			updateStatus(statusBarItem, deadStatus);
		}
	});
}

function createDefaultStatus(): vscode.StatusBarItem {
	let item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
	item.command = `${extId}.showOutputChannel`;
	updateStatus(item, defaultStatus);
	return item;
}

function updateStatus(item: vscode.StatusBarItem, statusParams: StatusParams) {
	let status;
	if (statusParams.state === "init") {
		status = "? MN";
	} else if (statusParams.state === "ok") {
		status = `✓ MN (${statusParams.docCount})`;
	} else {
		status = '☠️ MN';
	}

	item.text = status;
}

async function stopClient(client: LanguageClient | null) {
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
