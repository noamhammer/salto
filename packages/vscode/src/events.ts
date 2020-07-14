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
import * as vscode from 'vscode'
import * as path from 'path'
import { nacl } from '@salto-io/workspace'
import { readTextFile } from '@salto-io/file'
import _ from 'lodash'
import { diagnostics, workspace as ws } from '@salto-io/editor'
import { toVSDiagnostics } from './adapters'

const { FILE_EXTENSION } = nacl

const DIAG_IDLE_PERIOD = 500
export const createReportErrorsEventListener = (
  workspace: ws.EditorWorkspace,
  diagCollection: vscode.DiagnosticCollection
): (
) => void => _.debounce(
  async (): Promise<void> => {
    await workspace.awaitAllUpdates()
    const newDiag = toVSDiagnostics(
      workspace.baseDir,
      await diagnostics.getDiagnostics(workspace)
    )
    diagCollection.set(newDiag)
  },
  DIAG_IDLE_PERIOD
)


// This function is called whenever a file content is changed. The function will
// reparse the file that changed.
export const onTextChangeEvent = (
  event: vscode.TextDocumentChangeEvent,
  workspace: ws.EditorWorkspace
): void => {
  if (path.extname(event.document.fileName) === FILE_EXTENSION) {
    const naclFile = { filename: event.document.fileName, buffer: event.document.getText() }
    workspace.setNaclFiles(naclFile)
  }
}

export const onFileOpen = (): void => {
  vscode.commands.executeCommand('editor.foldAllMarkerRegions')
}

export const onFileDelete = (
  workspace: ws.EditorWorkspace,
  filename: string
): Promise<void> => {
  workspace.removeNaclFiles(filename)
  return workspace.awaitAllUpdates()
}

export const onFileChange = async (
  workspace: ws.EditorWorkspace,
  filename: string
): Promise<void> => {
  const buffer = await readTextFile(filename)
  workspace.setNaclFiles({ filename, buffer })
  return workspace.awaitAllUpdates()
}
