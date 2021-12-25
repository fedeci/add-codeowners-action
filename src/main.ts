import * as core from '@actions/core'
import * as github from '@actions/github'
import {
  branchName,
  getCodeowners,
  gitAddedFiles,
  updateCodeowners,
  userWantsToBeCodeowner
} from './utils'

async function run(): Promise<void> {
  try {
    const ghToken = core.getInput('token', { required: true })
    let baseBranchName = core.getInput('baseBranch')
    const newBranchName = core.getInput('newBranchName') || 'auto-codeowners'
    const codeownersPath = core.getInput('codeownersPath') || 'CODEOWNERS'
    const context = github.context

    if (context.eventName === 'pull_request') {
      const octokit = github.getOctokit(ghToken)
      // check if there is any new file
      const pullNumber = context.payload.pull_request?.number
      if (!pullNumber) throw new Error('Missing PR number.')
      const pullData = (
        await octokit.rest.pulls.get({
          ...context.repo,
          pull_number: pullNumber
        })
      ).data

      if (context.action === 'opened' || context.action === 'reopened') {
        // assert that the PR author effectively wants to be added as codeowner
        if (!userWantsToBeCodeowner(pullData.body)) return
        const newFiles = await gitAddedFiles(pullData.diff_url)
        // assert that there are new files in the PR
        if (!newFiles.length) return

        // Commit updated CODEOWNERS file and create a PR
        if (!baseBranchName) {
          const {
            data: { default_branch }
          } = await octokit.rest.repos.get({ ...context.repo })
          baseBranchName = default_branch
        }

        const {
          commit: { tree: lastCommitTree },
          sha: lastCommitSha
        } = (
          await octokit.rest.repos.listCommits({
            ...context.repo,
            sha: baseBranchName,
            per_page: 1
          })
        ).data[0]

        const pullAuthorName = pullData.user?.login

        const currentCodeowners = await getCodeowners(
          octokit,
          context.repo,
          lastCommitSha,
          codeownersPath
        )

        const newTree = await octokit.rest.git.createTree({
          ...context.repo,
          base_tree: lastCommitTree.sha,
          tree: [
            {
              path: codeownersPath,
              mode: '100644',
              content: updateCodeowners(
                currentCodeowners,
                newFiles,
                pullAuthorName
              )
            }
          ]
        })

        const newCommit = await octokit.rest.git.createCommit({
          ...context.repo,
          message: `chore: add ${pullAuthorName} to CODEOWNERS`,
          tree: newTree.data.sha,
          parents: [lastCommitSha]
        })

        await octokit.rest.git.createRef({
          ...context.repo,
          ref: `refs/heads/${branchName(newBranchName, pullNumber)}`,
          sha: newCommit.data.sha
        })

        await octokit.rest.pulls.create({
          ...context.repo,
          title: `chore: add ${pullAuthorName} to CODEOWNERS`,
          body: `Reference #${pullNumber}\n/cc @${pullAuthorName}`,
          base: baseBranchName,
          head: branchName(newBranchName, pullNumber)
        })
      } else if (context.action === 'closed') {
        try {
          await octokit.rest.git.deleteRef({
            ...context.repo,
            ref: `refs/heads/${branchName(newBranchName, pullNumber)}`
          })
        } catch {
          // do nothing if e.g. the ref does not exist
        }
      } else if (context.action === 'edited') {
        // refresh the PR
      }
    }
  } catch (error) {
    core.setFailed((error as Error).message)
  }
}

run()
