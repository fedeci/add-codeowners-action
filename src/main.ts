import * as core from '@actions/core'
import * as github from '@actions/github'
import fetch from 'node-fetch'
import parse from 'parse-diff'

async function addedFiles(diffUrl: string): Promise<string[]> {
  const diffText = await (await fetch(diffUrl)).text()
  return parse(diffText)
    .filter(file => file.new === true)
    .map(file => file.to!)
}

async function run(): Promise<void> {
  const ghToken = core.getInput('token', { required: true })
  let baseBranchName = core.getInput('baseBranch')
  const newBranchName = core.getInput('newBranchName') || 'auto-codeowners'
  const codeownersPath = core.getInput('codeownersPath') || 'CODEOWNERS.md'
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

    // assert that the PR author effectively wants to be added as codeowner
    if (
      !pullData.body ||
      !/- \[x\] Add me as codeowner of new files/g.test(pullData.body)
    ) {
      return
    }

    const newFiles = await addedFiles(pullData.diff_url)

    // assert that there are new files in the PR
    if (!newFiles.length) return

    // Commit updated CODEOWNERS file and create a PR
    if (!baseBranchName) {
      baseBranchName = (await octokit.rest.repos.get({ ...context.repo })).data
        .default_branch
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

    // eslint-disable-next-line no-inner-declarations
    async function getCurrentCodeowners(): Promise<string> {
      const { data } = await octokit.rest.repos.getContent({
        ...context.repo,
        path: codeownersPath,
        ref: lastCommitSha
      })
      if (Array.isArray(data) || data.type !== 'file')
        throw new Error(`Resource at path ${codeownersPath} is not a file.`)
      // @ts-expect-error Currently the API is badly typed and content is still unset for files
      return (data.content as string) || ''
    }

    const currentCodeowners = await getCurrentCodeowners()

    const newTree = await octokit.rest.git.createTree({
      ...context.repo,
      base_tree: lastCommitTree.sha,
      tree: [
        {
          path: codeownersPath,
          mode: '100644',
          content: newFiles.reduce((current, newFile) => {
            // TODO: check if the last character is a newline
            return `${current}${newFile} @${pullAuthorName}\n`
          }, currentCodeowners)
        }
      ]
    })

    const newCommit = await octokit.rest.git.createCommit({
      ...context.repo,
      message: `chore: add ${pullAuthorName} to CODEOWNERS`,
      tree: newTree.data.sha,
      parents: [lastCommitSha]
    })

    await octokit.rest.git.updateRef({
      ...context.repo,
      ref: `heads/${newBranchName}/${pullNumber}`,
      sha: newCommit.data.sha
    })

    await octokit.rest.pulls.create({
      ...context.repo,
      title: `chore: add ${pullAuthorName} to CODEOWNERS`,
      body: `Reference #${pullNumber}\n/cc @${pullAuthorName}`,
      base: newBranchName,
      head: `${baseBranchName}/${pullNumber}`
    })
  }
}

run()
