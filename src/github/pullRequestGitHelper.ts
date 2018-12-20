/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*
 * Inspired by and includes code from GitHub/VisualStudio project, obtained from https://github.com/github/VisualStudio/blob/165a97bdcab7559e0c4393a571b9ff2aed4ba8a7/src/GitHub.App/Services/PullRequestService.cs
 */

import Logger from '../common/logger';
import { Protocol } from '../common/protocol';
import { Remote, parseRepositoryRemotes } from '../common/remote';
import { IPullRequestModel } from './interface';
import { GitHubRepository } from './githubRepository';
import { Repository, Branch } from '../typings/git';

const PullRequestRemoteMetadataKey = 'github-pr-remote';
const PullRequestMetadataKey = 'github-pr-owner-number';
const PullRequestBranchRegex = /branch\.(.+)\.github-pr-owner-number/;

export interface PullRequestMetadata {
	owner: string;
	repositoryName: string;
	prNumber: number;
}

export class PullRequestGitHelper {
	static ID = 'PullRequestGitHelper';
	static async createAndCheckout(repository: Repository, pullRequest: IPullRequestModel) {
		// the branch is from a fork
		let localBranchName = await PullRequestGitHelper.calculateUniqueBranchNameForPR(repository, pullRequest);
		// create remote for this fork
		Logger.appendLine(`Branch ${localBranchName} is from a fork. Create a remote first.`, PullRequestGitHelper.ID);
		let remoteName = await PullRequestGitHelper.createRemote(repository, pullRequest.remote, pullRequest.head.repositoryCloneUrl);
		// fetch the branch
		let ref = `${pullRequest.head.ref}:${localBranchName}`;
		Logger.debug(`Fetch remote ${remoteName}`, PullRequestGitHelper.ID);
		await repository.fetch(remoteName, ref);
		await repository.checkout(localBranchName);
		// set remote tracking branch for the local branch
		await repository.setBranchUpstream(localBranchName, `refs/remotes/${remoteName}/${pullRequest.head.ref}`);
		let prBranchMetadataKey = `branch.${localBranchName}.${PullRequestMetadataKey}`;
		await repository.setConfig(prBranchMetadataKey, PullRequestGitHelper.buildPullRequestMetadata(pullRequest));
	}

	static async fetchAndCheckout(repository: Repository, githubRepositories: GitHubRepository[], pullRequest: IPullRequestModel): Promise<void> {
		const remote = PullRequestGitHelper.getHeadRemoteForPullRequest(repository, githubRepositories, pullRequest);
		if (!remote) {
			return PullRequestGitHelper.createAndCheckout(repository, pullRequest);
		}

		const branchName = pullRequest.head.ref;
		let remoteName = remote.remoteName;
		let branch: Branch;

		try {
			branch = await repository.getBranch(branchName);
			Logger.debug(`Checkout ${branchName}`, PullRequestGitHelper.ID);
			await repository.checkout(branchName);

			if (!branch.upstream) {
				// this branch is not associated with upstream yet
				const trackedBranchName = `refs/remotes/${remoteName}/${branchName}`;
				await repository.setBranchUpstream(branchName, trackedBranchName);
			}

			if (branch.behind !== undefined && branch.behind > 0 && branch.ahead === 0) {
				Logger.debug(`Pull from upstream`, PullRequestGitHelper.ID);
				await repository.pull();
			}
		} catch (err) {
			// there is no local branch with the same name, so we are good to fetch, create and checkout the remote branch.
			Logger.appendLine(`Branch ${remoteName}/${branchName} doesn't exist on local disk yet.`, PullRequestGitHelper.ID);
			const trackedBranchName = `refs/remotes/${remoteName}/${branchName}`;
			Logger.appendLine(`Fetch tracked branch ${trackedBranchName}`, PullRequestGitHelper.ID);
			await repository.fetch(remoteName, trackedBranchName);
			const trackedBranch = await repository.getBranch(trackedBranchName);
			// create branch
			await repository.createBranch(branchName, true, trackedBranch.commit);
			await repository.setBranchUpstream(branchName, trackedBranchName);
		}

		await PullRequestGitHelper.associateBranchWithPullRequest(repository, pullRequest, branchName);
	}

	static async checkoutExistingPullRequestBranch(repository: Repository, githubRepositories: GitHubRepository[], pullRequest: IPullRequestModel) {
		let key = PullRequestGitHelper.buildPullRequestMetadata(pullRequest);
		let configs = await repository.getConfigs();

		let branchInfos = configs.map(config => {
			let matches = PullRequestBranchRegex.exec(config.key);
			return {
				branch: matches && matches.length ? matches[1] : null,
				value: config.value
			};
		}).filter(c => c.branch && c.value === key);

		if (branchInfos && branchInfos.length) {
			// let's immediately checkout to branchInfos[0].branch
			await repository.checkout(branchInfos[0].branch);
			return true;
		} else {
			return false;
		}
	}

	static buildPullRequestMetadata(pullRequest: IPullRequestModel) {
		return pullRequest.base.repositoryCloneUrl.owner + '#' + pullRequest.base.repositoryCloneUrl.repositoryName + '#' + pullRequest.prNumber;
	}

	static parsePullRequestMetadata(value: string): PullRequestMetadata {
		if (value) {
			let matches = /(.*)#(.*)#(.*)/g.exec(value);
			if (matches && matches.length === 4) {
				const [, owner, repo, prNumber] = matches;
				return {
					owner: owner,
					repositoryName: repo,
					prNumber: Number(prNumber)
				};
			}
		}

		return null;
	}

	static async getMatchingPullRequestMetadataForBranch(repository: Repository, branchName: string): Promise<PullRequestMetadata> {
		try {
			let configKey = `branch.${branchName}.${PullRequestMetadataKey}`;
			let configValue = await repository.getConfig(configKey);
			return PullRequestGitHelper.parsePullRequestMetadata(configValue);
		} catch (_) {
			return null;
		}
	}

	static async createRemote(repository: Repository, baseRemote: Remote, cloneUrl: Protocol) {
		Logger.appendLine(`create remote for ${cloneUrl}.`, PullRequestGitHelper.ID);

		let remotes = parseRepositoryRemotes(repository);
		for (let remote of remotes) {
			if (new Protocol(remote.url).equals(cloneUrl)) {
				return remote.remoteName;
			}
		}

		let remoteName = PullRequestGitHelper.getUniqueRemoteName(repository, cloneUrl.owner);
		cloneUrl.update({
			type: baseRemote.gitProtocol.type
		});
		await repository.addRemote(remoteName, cloneUrl.toString());
		await repository.setConfig(`remote.${remoteName}.${PullRequestRemoteMetadataKey}`, 'true');
		return remoteName;
	}

	static async getUserCreatedRemotes(repository: Repository, remotes: Remote[]): Promise<Remote[]> {
		try {
			Logger.debug(`Get user created remotes - start`, PullRequestGitHelper.ID);
			const allConfigs = await repository.getConfigs();
			let remotesForPullRequest = [];
			for (let i = 0; i < allConfigs.length; i++) {
				let key = allConfigs[i].key;
				let matches = /^remote\.(.*)\.github-pr-remote$/.exec(key);
				if (matches && matches.length === 2 && allConfigs[i].value) {
					// this remote is created for pull requests
					remotesForPullRequest.push(matches[1]);
				}
			}

			let ret = remotes.filter(function (e) {
				return remotesForPullRequest.indexOf(e.remoteName) < 0;
			});
			Logger.debug(`Get user created remotes - end`, PullRequestGitHelper.ID);
			return ret;
		} catch (_) {
			return [];
		}
	}

	static async isRemoteCreatedForPullRequest(repository: Repository, remoteName: string) {
		try {
			Logger.debug(`Check if remote '${remoteName}' is created for pull request - start`, PullRequestGitHelper.ID);
			const isForPR = await repository.getConfig(`remote.${remoteName}.${PullRequestRemoteMetadataKey}`);
			Logger.debug(`Check if remote '${remoteName}' is created for pull request - end`, PullRequestGitHelper.ID);
			return isForPR === 'true';
		} catch (_) {
			return false;
		}
	}

	static async calculateUniqueBranchNameForPR(repository: Repository, pullRequest: IPullRequestModel): Promise<string> {
		let branchName = `pr/${pullRequest.author.login}/${pullRequest.prNumber}`;
		let result = branchName;
		let number = 1;

		while (true) {
			try {
				await repository.getBranch(result);
				result = branchName + '-' + number++;
			} catch (err) {
				break;
			}
		}

		return result;
	}

	static getUniqueRemoteName(repository: Repository, name: string) {
		let uniqueName = name;
		let number = 1;
		const remotes = parseRepositoryRemotes(repository);

		while (remotes.find(e => e.remoteName === uniqueName)) {
			uniqueName = name + number++;
		}

		return uniqueName;
	}

	static getHeadRemoteForPullRequest(repository: Repository, githubRepositories: GitHubRepository[], pullRequest: IPullRequestModel): Remote {
		for (let i = 0; i < githubRepositories.length; i++) {
			let remote = githubRepositories[i].remote;
			if (remote.gitProtocol && remote.gitProtocol.equals(pullRequest.head.repositoryCloneUrl)) {
				return remote;
			}
		}

		return null;
	}

	static async associateBranchWithPullRequest(repository: Repository, pullRequest: IPullRequestModel, branchName: string) {
		Logger.appendLine(`associate ${branchName} with Pull Request #${pullRequest.prNumber}`, PullRequestGitHelper.ID);
		let prConfigKey = `branch.${branchName}.${PullRequestMetadataKey}`;
		await repository.setConfig(prConfigKey, PullRequestGitHelper.buildPullRequestMetadata(pullRequest));
	}
}