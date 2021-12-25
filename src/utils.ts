import type * as github from '@actions/github'
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
