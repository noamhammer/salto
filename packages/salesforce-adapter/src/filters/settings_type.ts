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
import _ from 'lodash'
import {
  Element, InstanceElement, isObjectType,
  ObjectType, TypeElement,
} from '@salto-io/adapter-api'
import { logger } from '@salto-io/logging'
import { collections } from '@salto-io/lowerdash'
import { FilterCreator } from '../filter'
import {
  createInstanceElement, createMetadataTypeElements, apiName,
} from '../transformers/transformer'
import SalesforceClient from '../client/client'
import { id } from './utils'
import { FetchElements, ConfigChangeSuggestion, FilterContext } from '../types'
import { createSkippedListConfigChange } from '../config_change'
import { fetchMetadataInstances } from 'src/fetch'

const log = logger(module)
const { makeArray } = collections.array

export const SETTINGS_METADATA_TYPE = 'Settings'

// This method receiving settings type name and call to describeMetadataType
// And creating the new (settings) type
const createSettingsType = async (
  client: SalesforceClient,
  settingsTypesName: string,
  knownTypes: Map<string, TypeElement>): Promise<ObjectType[]> => {
  const typeFields = await client.describeMetadataType(settingsTypesName)
  const baseTypeNames = new Set([settingsTypesName])
  return createMetadataTypeElements({
    name: settingsTypesName,
    fields: typeFields.valueTypeFields,
    knownTypes,
    baseTypeNames,
    client,
    isSettings: true,
  })
}

const createSettingsTypes = async (
  client: SalesforceClient,
  config: FilterContext,
  settingsTypesNames: string[]): Promise<ObjectType[]> => {
  const knownTypes = new Map<string, TypeElement>()
  return _.flatten(await Promise.all(settingsTypesNames
    .map(settingsName => settingsName.concat(SETTINGS_METADATA_TYPE))
    .filter(typeName => !(config.metadataTypesSkippedList ?? []).includes(typeName))
    .map(typeName => createSettingsType(client, typeName, knownTypes)
      .catch(e => {
        log.error('failed to fetch settings type %s reason: %o', typeName, e)
        return []
      }))))
}

const extractSettingName = (settingType: string): string =>
  (settingType.endsWith(SETTINGS_METADATA_TYPE) ? settingType.slice(0, -8) : settingType)

// This method receiving settings type and call to readMetadata
// And creating the new instance
const createSettingsInstance = async (
  client: SalesforceClient,
  settingsType: ObjectType,
  config: FilterContext
): Promise<FetchElements<InstanceElement[]>> => {
  const typeName = apiName(settingsType)
  return fetchMetadataInstances(
    client,
    typeName,
    [extractSettingName(typeName)],
    settingsType,
    config.instancesRegexSkippedList
  )
}

const createSettingsInstances = async (
  client: SalesforceClient,
  config: FilterContext,
  settingsTypes: ObjectType[]
): Promise<FetchElements<InstanceElement[]>> => {
  const settingInstances = await Promise.all((settingsTypes)
    .filter(s => s.isSettings)
    .map(s => createSettingsInstance(client, s, config)))
  return {
    elements: _.flatten(settingInstances.map(ins => ins.elements)),
    configChanges: _.flatten(settingInstances.map(ins => ins.configChanges)),
  }
}

/**
 * Add settings type
 */
const filterCreator: FilterCreator = ({ client, config }) => ({
  /**
   * Add all settings types and instances as filter.
   *
   * @param elements
   */
  onFetch: async (elements: Element[]): Promise<ConfigChangeSuggestion[]> => {
    // Fetch list of all settings types
    const { result: settingsList } = await client.listMetadataObjects(
      { type: SETTINGS_METADATA_TYPE },
      // All errors are considered to be unhandled errors. If an error occur, throws an exception
      () => true
    )

    // Extract settings names
    const settingsTypesNames = settingsList.map(set => set.fullName)

    // Create all settings types
    const settingsTypes = await createSettingsTypes(client, config, settingsTypesNames)

    // Add all settings types to elements
    const knownTypesNames = new Set<string>(
      elements.filter(e => isObjectType(e)).map(a => id(a))
    )
    settingsTypes
      .filter(st => !knownTypesNames.has(id(st)))
      .forEach(e => elements.push(e))

    // Create all settings instances
    const settingsInstances = await createSettingsInstances(client, config, settingsTypes)

    settingsInstances.elements.forEach(e => elements.push(e))
    return settingsInstances.configChanges
  },
})

export default filterCreator
