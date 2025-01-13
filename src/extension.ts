/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';
import TelemetryReporter from '@vscode/extension-telemetry';
import axios, { isAxiosError } from 'axios';
import * as vscode from 'vscode';
import { LiveShare } from 'vsls/vscode.js';
import { PostCommitCommandsProvider, Repository } from './api/api';
import { GitApiImpl } from './api/api1';
import { registerCommands as registerCommandsFromModule } from './commands';
import { commands } from './common/executeCommands';
import { GitChangeType } from './common/file';
import Logger from './common/logger';
import * as PersistentState from './common/persistentState';
import { parseRepositoryRemotes } from './common/remote';
import { Resource } from './common/resources';
import { BRANCH_PUBLISH, EXPERIMENTAL_NOTIFICATIONS, FILE_LIST_LAYOUT, GIT, OPEN_DIFF_ON_CLICK, PR_SETTINGS_NAMESPACE, SHOW_INLINE_OPEN_FILE_ACTION } from './common/settingKeys';
import { TemporaryState } from './common/temporaryState';
import { Schemes, handler as uriHandler } from './common/uri';
import { EXTENSION_ID, FOCUS_REVIEW_MODE } from './constants';
import { createExperimentationService, ExperimentationTelemetry } from './experimentationService';
import { CredentialStore } from './github/credentials';
import { FolderRepositoryManager } from './github/folderRepositoryManager';
import { PullRequestModel } from './github/pullRequestModel';
import { RepositoriesManager } from './github/repositoriesManager';
import { registerBuiltinGitProvider, registerLiveShareGitProvider } from './gitProviders/api';
import { GitHubContactServiceProvider } from './gitProviders/GitHubContactServiceProvider';
import { GitLensIntegration } from './integrations/gitlens/gitlensImpl';
import { IssueFeatureRegistrar } from './issues/issueFeatureRegistrar';
import { migrate } from './migrations';
import { NotificationsFeatureRegister } from './notifications/notificationsFeatureRegistar';
import { CommentDecorationProvider } from './view/commentDecorationProvider';
import { CompareChanges } from './view/compareChangesTreeDataProvider';
import { CreatePullRequestHelper } from './view/createPullRequestHelper';
import { FileTypeDecorationProvider } from './view/fileTypeDecorationProvider';
import { getInMemPRFileSystemProvider } from './view/inMemPRContentProvider';
import { PullRequestChangesTreeDataProvider } from './view/prChangesTreeDataProvider';
import { PRNotificationDecorationProvider } from './view/prNotificationDecorationProvider';
import { PullRequestsTreeDataProvider } from './view/prsTreeDataProvider';
import { ReviewManager, ShowPullRequest } from './view/reviewManager';
import { ReviewsManager } from './view/reviewsManager';
import { TreeDecorationProviders } from './view/treeDecorationProviders';
import { WebviewViewCoordinator } from './view/webviewViewCoordinator';

const ingestionKey = process.env.TELEMETRY_INGESTION_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Configuration for AI summary generation
const AI_CONFIG = {
	model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-latest',
	maxTokens: process.env.ANTHROPIC_MAX_TOKENS ? parseInt(process.env.ANTHROPIC_MAX_TOKENS) : 4096,
	apiVersion: process.env.ANTHROPIC_API_VERSION || '2023-06-01',
	timeout: process.env.ANTHROPIC_TIMEOUT ? parseInt(process.env.ANTHROPIC_TIMEOUT) : 30000,
	endpoint: process.env.ANTHROPIC_API_ENDPOINT || 'https://api.anthropic.com/v1/messages'
};

// Move prompt template to a separate file or load from configuration
const PR_SUMMARY_PROMPT = process.env.PR_SUMMARY_PROMPT || `You are a specialized pull request analyzer tasked with examining the provided diff and creating a concise yet sufficiently detailed summary of the changes.

Your goal is to help a reviewer understand the changes in a pull request as quickly as possible whilst still knowing all the details.

Your output requirements:
1. Begin with a 2-3 line high-level summary capturing the overall impact of the pull request.
2. Group and describe related changes from highest to lowest impact, but feel free to vary the structure as appropriate. For example:
- Title, a brief summary of the change, then each file reference and explanation.
- Title, then file references with short explanations after each file.
- Title, summary, files grouped together, followed by a collective explanation.
3. Regardless of the structure, file references MUST be formatted as:
full/path/to/file (lines x-y)
It is IMPERATIVE that you the full path to the file is the FULL path to the file with no abbreviations, exactly as shown in the diff.
If you are refering to a whole directory, use the full path to the directory, e.g. full/path/to/directory/
4. Provide concise but sufficiently descriptive explanations (1-3 lines each) focusing on what changed, why, and how it affects the application.
5. Output only your final summary in valid Markdown - no extra remarks or disclaimers.

Guidelines on level of detail:
* If the PR introduces new components or APIs, briefly describe their purpose.
* If refactoring, mention the reason (performance, code organization, bug fixes) and the key benefit.
* If adding error handling or UI enhancements, note the user-facing or developer-facing benefits.
* Keep each explanation short, but ensure it offers enough context for reviewers.`;

let telemetry: ExperimentationTelemetry;

async function init(
	context: vscode.ExtensionContext,
	git: GitApiImpl,
	credentialStore: CredentialStore,
	repositories: Repository[],
	tree: PullRequestsTreeDataProvider,
	liveshareApiPromise: Promise<LiveShare | undefined>,
	showPRController: ShowPullRequest,
	reposManager: RepositoriesManager,
	createPrHelper: CreatePullRequestHelper
): Promise<void> {
	context.subscriptions.push(Logger);
	Logger.appendLine('Git repository found, initializing review manager and pr tree view.');

	context.subscriptions.push(credentialStore.onDidChangeSessions(async e => {
		if (e.provider.id === 'github') {
			await reposManager.clearCredentialCache();
			if (reviewsManager) {
				reviewsManager.reviewManagers.forEach(reviewManager => reviewManager.updateState(true));
			}
		}
	}));

	context.subscriptions.push(
		git.onDidPublish(async e => {
			// Only notify on branch publish events
			if (!e.branch) {
				return;
			}

			if (vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<'ask' | 'never' | undefined>(BRANCH_PUBLISH) !== 'ask') {
				return;
			}

			const reviewManager = reviewsManager.reviewManagers.find(
				manager => manager.repository.rootUri.toString() === e.repository.rootUri.toString(),
			);
			if (reviewManager?.isCreatingPullRequest) {
				return;
			}

			const folderManager = reposManager.folderManagers.find(
				manager => manager.repository.rootUri.toString() === e.repository.rootUri.toString());

			if (!folderManager || folderManager.gitHubRepositories.length === 0) {
				return;
			}

			const defaults = await folderManager.getPullRequestDefaults();
			if (defaults.base === e.branch) {
				return;
			}

			const create = vscode.l10n.t('Create Pull Request...');
			const dontShowAgain = vscode.l10n.t('Don\'t Show Again');
			const result = await vscode.window.showInformationMessage(
				vscode.l10n.t('Would you like to create a Pull Request for branch \'{0}\'?', e.branch),
				create,
				dontShowAgain,
			);
			if (result === create) {
				reviewManager?.createPullRequest(e.branch);
			} else if (result === dontShowAgain) {
				await vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).update(BRANCH_PUBLISH, 'never', vscode.ConfigurationTarget.Global);
			}
		}),
	);

	context.subscriptions.push(vscode.window.registerUriHandler(uriHandler));

	// Sort the repositories to match folders in a multiroot workspace (if possible).
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (workspaceFolders) {
		repositories = repositories.sort((a, b) => {
			let indexA = workspaceFolders.length;
			let indexB = workspaceFolders.length;
			for (let i = 0; i < workspaceFolders.length; i++) {
				if (workspaceFolders[i].uri.toString() === a.rootUri.toString()) {
					indexA = i;
				} else if (workspaceFolders[i].uri.toString() === b.rootUri.toString()) {
					indexB = i;
				}
				if (indexA !== workspaceFolders.length && indexB !== workspaceFolders.length) {
					break;
				}
			}
			return indexA - indexB;
		});
	}

	liveshareApiPromise.then(api => {
		if (api) {
			// register the pull request provider to suggest PR contacts
			api.registerContactServiceProvider('github-pr', new GitHubContactServiceProvider(reposManager));
		}
	});

	const changesTree = new PullRequestChangesTreeDataProvider(git, reposManager);
	context.subscriptions.push(changesTree);

	const activePrViewCoordinator = new WebviewViewCoordinator(context);
	context.subscriptions.push(activePrViewCoordinator);

	let reviewManagerIndex = 0;
	const reviewManagers = reposManager.folderManagers.map(
		folderManager => new ReviewManager(reviewManagerIndex++, context, folderManager.repository, folderManager, telemetry, changesTree, tree, showPRController, activePrViewCoordinator, createPrHelper, git),
	);
	const treeDecorationProviders = new TreeDecorationProviders(reposManager);
	context.subscriptions.push(treeDecorationProviders);
	treeDecorationProviders.registerProviders([new FileTypeDecorationProvider(), new CommentDecorationProvider(reposManager)]);

	const reviewsManager = new ReviewsManager(context, reposManager, reviewManagers, tree, changesTree, telemetry, credentialStore, git);
	context.subscriptions.push(reviewsManager);

	git.onDidChangeState(() => {
		Logger.appendLine(`Git initialization state changed: state=${git.state}`);
		reviewsManager.reviewManagers.forEach(reviewManager => reviewManager.updateState(true));
	});

	git.onDidOpenRepository(repo => {
		function addRepo() {
			// Make sure we don't already have a folder manager for this repo.
			const existing = reposManager.folderManagers.find(manager => manager.repository.rootUri.toString() === repo.rootUri.toString());
			if (existing) {
				Logger.appendLine(`Repo ${repo.rootUri} has already been setup.`);
				return;
			}
			const newFolderManager = new FolderRepositoryManager(reposManager.folderManagers.length, context, repo, telemetry, git, credentialStore, createPrHelper);
			reposManager.insertFolderManager(newFolderManager);
			const newReviewManager = new ReviewManager(
				reviewManagerIndex++,
				context,
				newFolderManager.repository,
				newFolderManager,
				telemetry,
				changesTree,
				tree,
				showPRController,
				activePrViewCoordinator,
				createPrHelper,
				git
			);
			reviewsManager.addReviewManager(newReviewManager);
		}
		addRepo();
		tree.notificationProvider.refreshOrLaunchPolling();
		const disposable = repo.state.onDidChange(() => {
			Logger.appendLine(`Repo state for ${repo.rootUri} changed.`);
			addRepo();
			disposable.dispose();
		});
	});

	git.onDidCloseRepository(repo => {
		reposManager.removeRepo(repo);
		reviewsManager.removeReviewManager(repo);
		tree.notificationProvider.refreshOrLaunchPolling();
	});

	tree.initialize(reviewsManager.reviewManagers.map(manager => manager.reviewModel), credentialStore);

	context.subscriptions.push(new PRNotificationDecorationProvider(tree.notificationProvider));

	registerCommandsFromModule(context, reposManager, reviewsManager, telemetry, tree);
	registerCommands(context, reposManager, reviewsManager, telemetry, tree);

	const layout = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<string>(FILE_LIST_LAYOUT);
	await vscode.commands.executeCommand('setContext', 'fileListLayout:flat', layout === 'flat');

	const issuesFeatures = new IssueFeatureRegistrar(git, reposManager, reviewsManager, context, telemetry);
	context.subscriptions.push(issuesFeatures);
	await issuesFeatures.initialize();

	const notificationsViewEnabled = vscode.workspace.getConfiguration(PR_SETTINGS_NAMESPACE).get<boolean>(EXPERIMENTAL_NOTIFICATIONS, false);
	if (notificationsViewEnabled) {
		const notificationsFeatures = new NotificationsFeatureRegister(credentialStore, reposManager, telemetry);
		context.subscriptions.push(notificationsFeatures);
	}

	context.subscriptions.push(new GitLensIntegration());

	await vscode.commands.executeCommand('setContext', 'github:initialized', true);

	registerPostCommitCommandsProvider(reposManager, git);

	// Make sure any compare changes tabs, which come from the create flow, are closed.
	CompareChanges.closeTabs();
	/* __GDPR__
		"startup" : {}
	*/
	telemetry.sendTelemetryEvent('startup');
}

function buildPrompt(content: { title: string; description: string; files: { fileName: string; status: string }[]; commits: string[] }): string {
	return `${PR_SUMMARY_PROMPT}

Here is the pull request information:
Title: ${content.title}
Original Description: ${content.description}

Files Changed:
${content.files.map(f => `- ${f.fileName} (${f.status})`).join('\n')}

Commit Messages:
${content.commits.join('\n')}

Start with your 2-3 line summary, then each section describing changes. Do not include any introductions or conclusions.`;
}

export async function generateAISummary(pullRequestModel: PullRequestModel): Promise<{ summary: string }> {
	const componentName = 'AI Summary Generator';
	Logger.debug('Starting AI summary generation', componentName);

	try {
		if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === 'YOUR_ANTHROPIC_API_KEY') {
			throw new Error('Anthropic API key not configured. Please set the ANTHROPIC_API_KEY environment variable.');
		}

		// Gather PR data
		const [commits, description, title] = await Promise.all([
			pullRequestModel.getCommits(),
			pullRequestModel.body || '',
			pullRequestModel.title
		]);
		await pullRequestModel.getFileChangesInfo();
		const fileChanges = Array.from(pullRequestModel.fileChanges.values());

		// Format content for prompt
		const content = {
			title,
			description,
			commits: commits.map(c => c.commit.message),
			files: fileChanges.map(f => ({
				fileName: f.fileName,
				status: GitChangeType[f.status]
			}))
		};

		const prompt = buildPrompt(content);

		// Make API request
		Logger.debug('Making API request to Claude', componentName);
		const response = await axios.post(AI_CONFIG.endpoint, {
			model: AI_CONFIG.model,
			max_tokens: AI_CONFIG.maxTokens,
			messages: [{
				role: 'user',
				content: prompt
			}]
		}, {
			headers: {
				'x-api-key': ANTHROPIC_API_KEY,
				'anthropic-version': AI_CONFIG.apiVersion,
				'content-type': 'application/json'
			},
			timeout: AI_CONFIG.timeout
		});

		if (!response.data.content || !response.data.content[0] || !response.data.content[0].text) {
			throw new Error('Invalid response format from Anthropic API');
		}

		const summary = response.data.content[0].text;
		Logger.debug('Successfully generated summary', componentName);
		return { summary };
	} catch (error) {
		if (isAxiosError(error)) {
			const errorMessage = error.response?.data?.error?.message || error.message;
			Logger.error(`Failed to generate AI summary: ${error.message}. Status: ${error.response?.status}. Error: ${errorMessage}`, componentName);
			throw new Error(`API request failed: ${errorMessage}`);
		}
		Logger.error(`Failed to generate AI summary: ${error}`, componentName);
		throw error;
	}
}

export async function activate(context: vscode.ExtensionContext): Promise<GitApiImpl> {
	Logger.appendLine(`Extension version: ${vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON.version}`, 'Activation');
	// eslint-disable-next-line @typescript-eslint/ban-ts-comment
	// @ts-ignore
	if (EXTENSION_ID === 'GitHub.vscode-pull-request-github-insiders') {
		const stable = vscode.extensions.getExtension('github.vscode-pull-request-github');
		if (stable !== undefined) {
			throw new Error(
				'GitHub Pull Requests and Issues Nightly cannot be used while GitHub Pull Requests and Issues is also installed. Please ensure that only one version of the extension is installed.',
			);
		}
	}

	const showPRController = new ShowPullRequest();
	vscode.commands.registerCommand('github.api.preloadPullRequest', async (shouldShow: boolean) => {
		await vscode.commands.executeCommand('setContext', FOCUS_REVIEW_MODE, true);
		await commands.focusView('github:activePullRequest:welcome');
		showPRController.shouldShow = shouldShow;
	});
	await setGitSettingContexts(context);

	// initialize resources
	Resource.initialize(context);
	Logger.debug('Creating API implementation.', 'Activation');
	const apiImpl = new GitApiImpl();

	telemetry = new ExperimentationTelemetry(new TelemetryReporter(ingestionKey));
	context.subscriptions.push(telemetry);

	await deferredActivate(context, apiImpl, showPRController);

	return apiImpl;
}

async function setGitSettingContexts(context: vscode.ExtensionContext) {
	// We set contexts instead of using the config directly in package.json because the git extension might not actually be available.
	const settings: [string, () => void][] = [
		['openDiffOnClick', () => vscode.workspace.getConfiguration(GIT, null).get(OPEN_DIFF_ON_CLICK, true)],
		['showInlineOpenFileAction', () => vscode.workspace.getConfiguration(GIT, null).get(SHOW_INLINE_OPEN_FILE_ACTION, true)]
	];
	for (const [contextName, setting] of settings) {
		commands.setContext(contextName, setting());
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(`${GIT}.${contextName}`)) {
				commands.setContext(contextName, setting());
			}
		}));
	}
}

async function doRegisterBuiltinGitProvider(context: vscode.ExtensionContext, credentialStore: CredentialStore, apiImpl: GitApiImpl): Promise<boolean> {
	const builtInGitProvider = await registerBuiltinGitProvider(credentialStore, apiImpl);
	if (builtInGitProvider) {
		context.subscriptions.push(builtInGitProvider);
		return true;
	}
	return false;
}

function registerPostCommitCommandsProvider(reposManager: RepositoriesManager, git: GitApiImpl) {
	const componentId = 'GitPostCommitCommands';
	class Provider implements PostCommitCommandsProvider {

		getCommands(repository: Repository) {
			Logger.debug(`Looking for remote. Comparing ${repository.state.remotes.length} local repo remotes with ${reposManager.folderManagers.reduce((prev, curr) => prev + curr.gitHubRepositories.length, 0)} GitHub repositories.`, componentId);
			const repoRemotes = parseRepositoryRemotes(repository);

			const found = reposManager.folderManagers.find(folderManager => folderManager.findRepo(githubRepo => {
				return !!repoRemotes.find(remote => {
					return remote.equals(githubRepo.remote);
				});
			}));
			Logger.debug(`Found ${found ? 'a repo' : 'no repos'} when getting post commit commands.`, componentId);
			return found ? [{
				command: 'pr.pushAndCreate',
				title: vscode.l10n.t('{0} Commit & Create Pull Request', '$(git-pull-request-create)'),
				tooltip: vscode.l10n.t('Commit & Create Pull Request')
			}] : [];
		}
	}

	function hasGitHubRepos(): boolean {
		return reposManager.folderManagers.some(folderManager => folderManager.gitHubRepositories.length > 0);
	}
	function tryRegister(): boolean {
		Logger.debug('Trying to register post commit commands.', 'GitPostCommitCommands');
		if (hasGitHubRepos()) {
			Logger.debug('GitHub remote(s) found, registering post commit commands.', componentId);
			git.registerPostCommitCommandsProvider(new Provider());
			return true;
		}
		return false;
	}

	if (!tryRegister()) {
		const reposDisposable = reposManager.onDidLoadAnyRepositories(() => {
			if (tryRegister()) {
				reposDisposable.dispose();
			}
		});
	}
}

async function deferredActivateRegisterBuiltInGitProvider(context: vscode.ExtensionContext, apiImpl: GitApiImpl, credentialStore: CredentialStore) {
	Logger.debug('Registering built in git provider.', 'Activation');
	if (!(await doRegisterBuiltinGitProvider(context, credentialStore, apiImpl))) {
		const extensionsChangedDisposable = vscode.extensions.onDidChange(async () => {
			if (await doRegisterBuiltinGitProvider(context, credentialStore, apiImpl)) {
				extensionsChangedDisposable.dispose();
			}
		});
		context.subscriptions.push(extensionsChangedDisposable);
	}
}

async function deferredActivate(context: vscode.ExtensionContext, apiImpl: GitApiImpl, showPRController: ShowPullRequest) {
	Logger.debug('Initializing state.', 'Activation');
	PersistentState.init(context);
	await migrate(context);
	TemporaryState.init(context);
	Logger.debug('Creating credential store.', 'Activation');
	const credentialStore = new CredentialStore(telemetry, context);
	context.subscriptions.push(credentialStore);
	const experimentationService = await createExperimentationService(context, telemetry);
	await experimentationService.initializePromise;
	await experimentationService.isCachedFlightEnabled('githubaa');
	const showBadge = (vscode.env.appHost === 'desktop');
	await credentialStore.create(showBadge ? undefined : { silent: true });

	deferredActivateRegisterBuiltInGitProvider(context, apiImpl, credentialStore);

	Logger.debug('Registering live share git provider.', 'Activation');
	const liveshareGitProvider = registerLiveShareGitProvider(apiImpl);
	context.subscriptions.push(liveshareGitProvider);
	const liveshareApiPromise = liveshareGitProvider.initialize();

	context.subscriptions.push(apiImpl);

	Logger.debug('Creating tree view.', 'Activation');
	const reposManager = new RepositoriesManager(credentialStore, telemetry);
	context.subscriptions.push(reposManager);

	const prTree = new PullRequestsTreeDataProvider(telemetry, context, reposManager);
	context.subscriptions.push(prTree);
	context.subscriptions.push(credentialStore.onDidGetSession(() => prTree.refresh(undefined, true)));
	Logger.appendLine('Looking for git repository');
	const repositories = apiImpl.repositories;
	Logger.appendLine(`Found ${repositories.length} repositories during activation`);
	const createPrHelper = new CreatePullRequestHelper();
	context.subscriptions.push(createPrHelper);

	let folderManagerIndex = 0;
	const folderManagers = repositories.map(
		repository => new FolderRepositoryManager(folderManagerIndex++, context, repository, telemetry, apiImpl, credentialStore, createPrHelper),
	);
	context.subscriptions.push(...folderManagers);
	for (const folderManager of folderManagers) {
		reposManager.insertFolderManager(folderManager);
	}

	const inMemPRFileSystemProvider = getInMemPRFileSystemProvider({ reposManager, gitAPI: apiImpl, credentialStore })!;
	const readOnlyMessage = new vscode.MarkdownString(vscode.l10n.t('Cannot edit this pull request file. [Check out](command:pr.checkoutFromReadonlyFile) this pull request to edit.'));
	readOnlyMessage.isTrusted = { enabledCommands: ['pr.checkoutFromReadonlyFile'] };
	context.subscriptions.push(vscode.workspace.registerFileSystemProvider(Schemes.Pr, inMemPRFileSystemProvider, { isReadonly: readOnlyMessage }));

	await init(context, apiImpl, credentialStore, repositories, prTree, liveshareApiPromise, showPRController, reposManager, createPrHelper);
}

export async function deactivate() {
	if (telemetry) {
		telemetry.dispose();
	}
}

async function registerCommands(
	context: vscode.ExtensionContext,
	reposManager: RepositoriesManager,
	_reviewsManager: ReviewsManager,
	_telemetry: ExperimentationTelemetry,
	_tree: PullRequestsTreeDataProvider,
) {
	context.subscriptions.push(
		vscode.commands.registerCommand('pr.generate-ai-summary', async () => {
			try {
				await vscode.commands.executeCommand('github-pr.focus.output');
				Logger.debug('Starting AI summary generation', 'Command Handler');

				const activePullRequests = reposManager.folderManagers
					.map(manager => manager.activePullRequest)
					.filter((pr): pr is PullRequestModel => pr !== undefined);

				if (activePullRequests.length === 0) {
					throw new Error('No active pull request found');
				}

				const pr = activePullRequests[0];
				const summary = await generateAISummary(pr);
				return { summary };
			} catch (e) {
				Logger.error(`Failed to generate AI summary: ${e}`, 'Command Handler');
				vscode.window.showErrorMessage(`Failed to generate AI summary: ${e}`);
				return undefined;
			}
		})
	);
}
