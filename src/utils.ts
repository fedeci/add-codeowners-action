import * as core from '@actions/core'
import * as github from '@actions/github'
import fetch from 'node-fetch'
import parseDiff from 'parse-diff'

export async function gitAddedFiles(diffUrl: string): Promise<string[]> {
  const diffText = await (await fetch(diffUrl)).text()
  return parseDiff(diffText)
    .filter(file => file.new === true)
    .map(file => file.to!)
}

/**
 *
 * @param repo A repo object containing the owner and the name of the repo
 * @param sha The sha1
 * @param path The path to the codeowners file
 */
export async function getCodeowners(
  octokit: ReturnType<typeof github.getOctokit>,
  repo: { owner: string; repo: string },
  sha: string,
  path: string
): Promise<string> {
  const { data } = await octokit.rest.repos.getContent({
    ...repo,
    path,
    ref: sha
  })
  if (Array.isArray(data) || data.type !== 'file')
    throw new Error(`Resource at path ${path} is not a file.`)
  // @ts-expect-error Currently the API is badly typed and content is still unset for files
  return Buffer.from((data.content as string) || '', 'base64').toString('utf8')
}

export function branchName(prefix: string, hash: number): string {
  return `${prefix}/${hash}`
}

export function userWantsToBeCodeowner(pullBody: string | null): boolean {
  if (!pullBody) return false
  return /- \[x\] Add me as codeowner of new files/g.test(pullBody)
}

export function updateCodeowners(
  oldContent: string,
  newFiles: string[],
  pullAuthorName: string | undefined
): string {
  return newFiles.reduce(
    (current, newFile) => `${current}${newFile} @${pullAuthorName}\n`,
    oldContent.at(-1) === '\n' ? oldContent : `${oldContent}\n`
  )
}

type PullDataUser = Record<string, unknown> & {
  login: string
}
type PullData = Record<string, unknown> & {
  diff_url: string
  user: PullDataUser | null
  number: number
}

export async function createOrUpdateCodeownersPr(
  octokit: ReturnType<typeof github.getOctokit>,
  newBranchPrefix: string,
  baseBranchName: string,
  codeownersPath: string,
  pullData: PullData
): Promise<void> {
  // check if there is any new file in the PR
  const newFiles = await gitAddedFiles(pullData.diff_url)
  if (!newFiles.length) return

  core.debug(`New files: ${newFiles.join(', ')}`)

  const context = github.context

  // Commit updated CODEOWNERS file and add/update ref
  if (!baseBranchName) {
    const {
      data: { default_branch }
    } = await octokit.rest.repos.get({ ...context.repo })
    baseBranchName = default_branch
  }

  core.debug(`Base branch name: ${baseBranchName}`)

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

  core.debug(`Base branch last commit-tree sha: ${lastCommitTree.sha}`)
  core.debug(`Base branch last commit sha: ${lastCommitSha}`)

  const newBranchName = branchName(newBranchPrefix, pullData.number)
  const pullAuthorName = pullData.user?.login

  core.debug(`Pull author name: ${pullAuthorName}`)

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
        content: updateCodeowners(currentCodeowners, newFiles, pullAuthorName)
      }
    ]
  })

  core.debug(`New tree sha: ${newTree.data.sha}`)

  const newCommit = await octokit.rest.git.createCommit({
    ...context.repo,
    message: `chore: add ${pullAuthorName} to CODEOWNERS`,
    tree: newTree.data.sha,
    parents: [lastCommitSha]
  })

  core.debug(`New commit sha: ${newCommit.data.sha}`)

  try {
    const ref = `heads/${newBranchName}`
    await octokit.rest.git.updateRef({
      ...context.repo,
      ref,
      sha: newCommit.data.sha,
      force: true
    })
    core.debug(`Ref updated: ${ref}`)
  } catch (error) {
    const newRef = `refs/heads/${newBranchName}`
    await octokit.rest.git.createRef({
      ...context.repo,
      ref: newRef,
      sha: newCommit.data.sha
    })
    core.debug(`New ref created: ${newRef}`)
  }

  const pullsFromRef = (
    await octokit.rest.pulls.list({
      ...context.repo,
      state: 'open',
      head: `${context.repo.owner}:${newBranchName}`
    })
  ).data
  core.debug(
    `Found PRs from the ${newBranchName} branch: ${pullsFromRef
      .map(p => p.number)
      .join(', ')}`
  )

  if (!pullsFromRef.length) {
    await octokit.rest.pulls.create({
      ...context.repo,
      title: `chore: add ${pullAuthorName} to CODEOWNERS`,
      body: `Reference #${pullData.number}\n/cc @${pullAuthorName}`,
      base: baseBranchName,
      head: newBranchName
    })
  }
}
