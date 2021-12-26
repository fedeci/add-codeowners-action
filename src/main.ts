import * as core from '@actions/core'
import * as github from '@actions/github'
import {
  branchName,
  createOrUpdateCodeownersPr,
  userWantsToBeCodeowner
} from './utils'

async function run(): Promise<void> {
  try {
    const ghToken = core.getInput('token', { required: true })
    const baseBranchName = core.getInput('baseBranch')
    const newBranchName = core.getInput('newBranchName') || 'auto-codeowners'
    const codeownersPath = core.getInput('codeownersPath') || 'CODEOWNERS'
    const context = github.context

    core.debug(`Event: ${context.eventName}.${context.payload.action}`)

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

      if (
        context.payload.action === 'opened' ||
        context.payload.action === 'reopened' ||
        context.payload.action === 'synchronize'
      ) {
        // assert that the PR author effectively wants to be added as codeowner
        if (!userWantsToBeCodeowner(pullData.body)) {
          core.debug('User does not want to be a codeowner')
          return
        }

        await createOrUpdateCodeownersPr(
          octokit,
          newBranchName,
          baseBranchName,
          codeownersPath,
          pullData
        )
      } else if (context.payload.action === 'closed') {
        try {
          await octokit.rest.git.deleteRef({
            ...context.repo,
            ref: `refs/heads/${branchName(newBranchName, pullNumber)}`
          })
          core.debug(`Closed PR`)
        } catch {
          core.debug(`Could not find ref to delete`)
          // do nothing if e.g. the ref does not exist
        }
      } else if (context.payload.action === 'edited') {
        // refresh the PR
        if (!userWantsToBeCodeowner(pullData.body)) {
          try {
            await octokit.rest.git.deleteRef({
              ...context.repo,
              ref: `refs/heads/${branchName(newBranchName, pullNumber)}`
            })
            core.debug(`Closed PR`)
          } catch {
            core.debug(`Could not find ref to delete`)
            // do nothing if e.g. the ref does not exist
          }
          return
        }

        await createOrUpdateCodeownersPr(
          octokit,
          newBranchName,
          baseBranchName,
          codeownersPath,
          pullData
        )
      }
    }
  } catch (error) {
    core.setFailed((error as Error).message)
  }
}

run()
