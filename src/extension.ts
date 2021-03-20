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

let client: LanguageClient | null;
let statusBarItem: vscode.StatusBarItem;

type RunState = "init" | "dead" | "ok";

type StatusParams = {
	state: RunState,
	notes: number
};
const defaultStatus: StatusParams = { state: "init", notes: 0 };
const deadStatus: StatusParams = { state: "dead", notes: 0 };

const extId = "zetaNote";
const extName = "Zeta Note";

const statusNotificationType = new NotificationType<StatusParams>("zeta-note/status");

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
};

class ExperimentalFeatures implements StaticFeature {
	fillClientCapabilities(capabilities: ClientCapabilities): void {
		const experimental: ExperimentalCapabilities = capabilities.experimental ?? {};
		experimental.codeLensShowReferences = true;
		experimental.followLinks = true;

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

	client = await connectToServer(statusBarItem);

	// Setup commands
	let restartServerCmd = vscode.commands.registerCommand(`${extId}.restartServer`, async () => {
		stopClient(client);
		updateStatus(statusBarItem, defaultStatus);

		client = await connectToServer(statusBarItem);
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

async function connectToServer(status: vscode.StatusBarItem): Promise<LanguageClient | null> {
	// Try to find the server binary and create ServerOptions
	// Return early if no binary can be found
	let serverOptions: ServerOptions;
	let maybeServerOptions: ServerOptions | null = await mkServerOptions();
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

async function mkServerOptions(): Promise<ServerOptions | null> {
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

	return null;
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
		return 'zeta-note.exe';
	} else if (platform === 'darwin' || platform === 'linux') {
		return 'zeta-note';
	} else {
		throw new Error(`Unsupported platform: ${platform}`);
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
			console.log('Got zeta-note/status notification');
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
		status = "? ZN";
	} else if (statusParams.state === "ok") {
		status = `✓ ZN (${statusParams.notes})`;
	} else {
		status = '☠️ ZN';
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
