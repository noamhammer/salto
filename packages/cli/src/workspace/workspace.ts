/*
*                      Copyright 2020 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
import { EOL } from 'os'
import _ from 'lodash'
import wu from 'wu'
import { Workspace, FetchChange, Tags, loadLocalWorkspace } from '@salto-io/core'
import { SaltoError } from '@salto-io/adapter-api'
import { logger } from '@salto-io/logging'
import { formatWorkspaceError, formatWorkspaceLoadFailed, formatDetailedChanges,
  formatFinishedLoading, formatWorkspaceAbort } from '../formatter'
import { CliOutput, SpinnerCreator } from '../types'
import {
  shouldContinueInCaseOfWarnings,
  shouldAbortWorkspaceInCaseOfValidationError,
  shouldCancelInCaseOfNoRecentState,
} from '../callbacks'
import Prompts from '../prompts'
import { groupRelatedErrors } from './errors'

const log = logger(module)

export const MAX_DETAIL_CHANGES_TO_LOG = 100
export const MAX_WORKSPACE_ERRORS_TO_LOG = 30
const isError = (e: SaltoError): boolean => (e.severity === 'Error')

export type LoadWorkspaceResult = {
  workspace: Workspace
  errored: boolean
}
type WorkspaceStatus = 'Error' | 'Warning' | 'Valid'
type WorkspaceStatusErrors = {
  status: WorkspaceStatus
  errors: ReadonlyArray<SaltoError>
}

export type LoadWorkspaceOptions = {
  force: boolean
  printStateRecency: boolean
  recommendStateRecency: boolean
  spinnerCreator: SpinnerCreator
  sessionEnv?: string
  services?: string[]
}

export const validateWorkspace = async (ws: Workspace): Promise<WorkspaceStatusErrors> => {
  const errors = await ws.errors()
  if (!errors.hasErrors()) {
    return { status: 'Valid', errors: [] }
  }
  if (wu.some(isError, errors.all())) {
    return { status: 'Error', errors: groupRelatedErrors([...wu.filter(isError, errors.all())]) }
  }
  return { status: 'Warning', errors: groupRelatedErrors([...errors.all()]) }
}

export const formatWorkspaceErrors = async (
  workspace: Workspace,
  errors: Iterable<SaltoError>,
): Promise<string> => (
  (await Promise.all(
    wu(errors)
      .slice(0, MAX_WORKSPACE_ERRORS_TO_LOG)
      .map(err => workspace.transformError(err))
      .map(async err => formatWorkspaceError(await err))
  )).join('\n')
)

const printWorkspaceErrors = async (
  status: WorkspaceStatusErrors['status'],
  errorsStr: string,
  { stdout, stderr }: CliOutput,
): Promise<void> => {
  if (status === 'Valid') return
  const stream = (status === 'Error' ? stderr : stdout)
  stream.write(`\n${errorsStr}\n`)
}

export const loadWorkspace = async (workingDir: string, cliOutput: CliOutput,
  { force = false,
    printStateRecency = false,
    recommendStateRecency = false,
    spinnerCreator = undefined,
    sessionEnv = undefined,
    services = undefined }: Partial<LoadWorkspaceOptions> = {}): Promise<LoadWorkspaceResult> => {
  const spinner = spinnerCreator
    ? spinnerCreator(Prompts.LOADING_WORKSPACE, {})
    : { succeed: () => undefined, fail: () => undefined }

  const workspace = await loadLocalWorkspace(workingDir)
  if (!_.isUndefined(sessionEnv)) {
    await workspace.setCurrentEnv(sessionEnv, false)
  }

  const { status, errors } = await validateWorkspace(workspace)
  // Stop the spinner
  if (status === 'Error') {
    spinner.fail(formatWorkspaceLoadFailed(errors.length))
  } else {
    spinner.succeed(formatFinishedLoading(workspace.currentEnv()))
  }
  // Print state's recency
  const stateRecencies = await Promise.all((services || workspace.services())
    .map(service => workspace.getStateRecency(service)))

  if (printStateRecency) {
    const prompt = stateRecencies.map(recency => (recency.status === 'Nonexistent'
      ? Prompts.NONEXISTENT_STATE(recency.serviceName)
      : Prompts.STATE_RECENCY(recency.serviceName, recency.date as Date))).join(EOL)
    cliOutput.stdout.write(prompt + EOL)
  }
  // Offer to cancel because of stale state
  const invalidRecencies = stateRecencies.filter(recency => recency.status !== 'Valid')
  if (recommendStateRecency && !force
    && !_.isEmpty(invalidRecencies) && status !== 'Error') {
    const shouldCancel = await shouldCancelInCaseOfNoRecentState(invalidRecencies, cliOutput)
    if (shouldCancel) {
      return { workspace, errored: true }
    }
  }
  // Handle warnings/errors
  await printWorkspaceErrors(status, await formatWorkspaceErrors(workspace, errors), cliOutput)
  if (status === 'Warning' && !force) {
    const shouldContinue = await shouldContinueInCaseOfWarnings(errors.length, cliOutput)
    return { workspace, errored: !shouldContinue }
  }
  if (status === 'Error') {
    cliOutput.stdout.write(formatWorkspaceAbort(errors.length))
  }
  return { workspace, errored: status === 'Error' }
}

export const updateWorkspace = async (ws: Workspace, cliOutput: CliOutput,
  changes: readonly FetchChange[], isolated = false): Promise<boolean> => {
  if (changes.length > 0) {
    if (!await ws.isEmpty(true)) {
      log.info('going to update workspace with %d changes', changes.length)
      if (changes.length > MAX_DETAIL_CHANGES_TO_LOG) {
        log.info('going to log only %d changes', MAX_DETAIL_CHANGES_TO_LOG)
      }
      formatDetailedChanges([changes.slice(0, MAX_DETAIL_CHANGES_TO_LOG).map(c => c.change)])
        .split('\n')
        .forEach(s => log.info(s))
    }

    await ws.updateNaclFiles(
      changes.map(c => c.change),
      isolated ? 'isolated' : undefined
    )
    const { status, errors } = await validateWorkspace(ws)
    const formattedErrors = await formatWorkspaceErrors(ws, errors)
    await printWorkspaceErrors(status, formattedErrors, cliOutput)
    if (status === 'Error') {
      const shouldAbort = await shouldAbortWorkspaceInCaseOfValidationError(errors.length)
      if (!shouldAbort) {
        await ws.flush()
      }
      log.warn(formattedErrors)
      return false
    }
  }
  await ws.flush()
  log.debug('finished updating workspace')
  return true
}

export const getWorkspaceTelemetryTags = async (ws: Workspace): Promise<Tags> => (
  { workspaceID: ws.uid }
)
