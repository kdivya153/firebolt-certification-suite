/**
 * Copyright 2024 Comcast Cable Communications Management, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
import Config from './config';
import Validation from './validation';
import TransportLayer from './transport';
import Queue from './queue';
const { v4: uuidv4 } = require('uuid');
const CONSTANTS = require('../../constants/constants');
const defaultDirectory = CONSTANTS.DEFAULT_DIRECTORY;
const jsonFile = CONSTANTS.JSON_FILE_EXTENSION;
const UTILS = require('./utils');
let appTransport;
const path = require('path');
const EXTERNAL_DIR = 'cypress/TestCases/external';

export default function (module) {
  const config = new Config(module);
  const validationModule = new Validation(module);
  const transport = new TransportLayer();
  let clientCreated = false;
  Cypress.env(CONSTANTS.RESPONSE_TOPIC_LIST, []);

  // Fetch the required appTransport from config module
  appTransport = module.appTransport;

  // before All
  before(() => {
    // Added below cypress commands to clear local browser cache and to reload browser
    cy.clearLocalStorage();
    cy.reload(true);
    cy.wrap(pubSubClientCreation(), { timeout: CONSTANTS.SEVEN_SECONDS_TIMEOUT }).then((result) => {
      if (result) {
        cy.log('Successfully established a pub/sub connection.');
      } else {
        cy.log('Unable to establish a pub/sub connection.');
      }
    });

    // Create an instance of global queue
    const messageQueue = new Queue();
    Cypress.env(CONSTANTS.MESSAGE_QUEUE, messageQueue);
    UTILS.parseExceptionList();
    cy.getModuleReqIdJson();
    if (UTILS.getEnvVariable(CONSTANTS.PERFORMANCE_METRICS) == true) {
      cy.startOrStopPerformanceService(CONSTANTS.START).then((response) => {
        if (response) {
          Cypress.env(CONSTANTS.IS_PERFORMANCE_METRICS_ENABLED, true);
        }
      });
    } else {
      cy.log(
        'Performance metrics service not active. To use perforance metrics service, pass performanceMetrics environment variable as true'
      );
    }
    destroyGlobalObjects([CONSTANTS.LIFECYCLE_APP_OBJECT_LIST]);
  });

  // beforeEach
  beforeEach(() => {
    cy.testDataHandler(CONSTANTS.BEFORE_OPERATION);
  });

  /**
   * @module main
   * @function getModuleReqIdJson
   * @description Combine the moduleReqId json present in FCS and configmodules.
   * @example
   * getModuleReqIdJson()
   */
  Cypress.Commands.add('getModuleReqIdJson', () => {
    cy.task(CONSTANTS.READFILEIFEXISTS, CONSTANTS.FCS_MODULEREQID_PATH).then((fcsData) => {
      cy.task(CONSTANTS.READFILEIFEXISTS, CONSTANTS.EXTERNAL_MODULEREQID_PATH).then(
        (externalData) => {
          if (fcsData && externalData) {
            fcsData = JSON.parse(fcsData);
            externalData = JSON.parse(externalData);
            if (fcsData.scenarioNames && externalData.scenarioNames) {
              const FCS = Object.keys(fcsData.scenarioNames);
              const config = Object.keys(externalData.scenarioNames);
              let fcsModulesData, configModulesData;

              // Loop through all the modules from moduleReqId json
              FCS.map((module) => {
                // Check whether the module present in FCS moduleReqId present in external moduleReqId
                if (config?.includes(module)) {
                  fcsModulesData = Object.keys(fcsData.scenarioNames[module]);
                  configModulesData = Object.keys(externalData.scenarioNames[module]);
                  fcsModulesData.map((scenario) => {
                    // Check whether the scenario present in FCS moduleReqId present in external moduleReqId
                    if (configModulesData?.includes(scenario)) {
                      const scenarioValueKeys = Object.keys(
                        externalData.scenarioNames[module][scenario]
                      );
                      // Combine both the scenario objects
                      scenarioValueKeys.map((key) => {
                        fcsData.scenarioNames[module][scenario][key] =
                          externalData.scenarioNames[module][scenario][key];
                      });
                    }
                    Cypress.env(CONSTANTS.MODULEREQIDJSON, fcsData);
                  });
                } else {
                  Cypress.env(CONSTANTS.MODULEREQIDJSON, fcsData);
                }
              });
            } else {
              assert(
                false,
                'scenarioNames is missing in module requirementId json in FCS/ external module'
              );
            }
          } else {
            if (!fcsData) {
              assert(false, 'Module requirementId json file is missing in fixtures');
            }
            fcsData = JSON.parse(fcsData);
            Cypress.env(CONSTANTS.MODULEREQIDJSON, fcsData);
          }
        }
      );
    });
  });

  /**
   * @module main
   * @function pubSubClientCreation
   * @description Establishing the pubsub connection and subscribing to the response topic.
   * @example
   * pubSubClientCreation()
   */
  function pubSubClientCreation() {
    return new Promise(async (resolve, reject) => {
      if (!clientCreated && appTransport.init) {
        try {
          const responseTopic = UTILS.getTopic(null, CONSTANTS.SUBSCRIBE);

          // Initialize required client
          await appTransport.init();

          if (
            responseTopic != undefined &&
            !UTILS.getEnvVariable(CONSTANTS.RESPONSE_TOPIC_LIST).includes(responseTopic)
          ) {
            // Subscribe to topic and pass the results to the callback function
            appTransport.subscribe(responseTopic, subscribeResults);
            UTILS.getEnvVariable(CONSTANTS.RESPONSE_TOPIC_LIST).push(responseTopic);
          }
          clientCreated = true;
          resolve(true);
        } catch (error) {
          // If an error occurs, reject the promise with the error
          reject('Failed to initiate PubSubClient' + error);
        }
      } else {
        resolve(false);
      }
    });
  }

  // after All
  after(() => {
    (async () => {
      try {
        if (UTILS.getEnvVariable(CONSTANTS.IS_PERFORMANCE_METRICS_ENABLED, false) == true) {
          cy.startOrStopPerformanceService(CONSTANTS.STOP).then((response) => {
            if (response) {
              Cypress.env(CONSTANTS.IS_PERFORMANCE_METRICS_ENABLED, false);
            }
          });
        }
        // unsubscribing the list of topics
        appTransport.unsubscribe(UTILS.getEnvVariable(CONSTANTS.RESPONSE_TOPIC_LIST));

        // Unsubscribe from WebSocket if the client is available
        const webSocketClient = UTILS.getEnvVariable('webSocketClient', false);
        if (webSocketClient) {
          UTILS.unsubscribe(webSocketClient);
          Cypress.env('webSocketClient', null); // Clear the WebSocket client from Cypress environment
        }
        // Delete the external TestCase directory if exist
        cy.task('checkDirectoryExist', EXTERNAL_DIR).then((directoryExists) => {
          if (directoryExists) {
            cy.task('deleteFolder', EXTERNAL_DIR).then(() => {
              cy.log(`Folder ${EXTERNAL_DIR} has been deleted.`);
            });
          } else {
            cy.log(`External directory ${EXTERNAL_DIR} does not exist.`);
          }
        });
      } catch (err) {
        cy.log(`Something went wrong when attempting to unsubscribe: ${err}`);
      }
    })();
  });

  /**
   * @module main
   * @function sendMessagetoPlatforms
   * @description send message based on platform which will be pulled from config manager.
   * @param {*} requestMap - requestMap should contain method and param
   * @example
   * cy.sendMessagetoPlatforms({"method": "closedCaptioning", "param": {}})
   */
  Cypress.Commands.add('sendMessagetoPlatforms', (requestMap) => {
    cy.wrap(requestMap, { timeout: CONSTANTS.SEVEN_SECONDS_TIMEOUT }).then(async (requestMap) => {
      return new Promise(async (resolve) => {
        const message = await config.getRequestOverride(requestMap);
        // perform MTC call/FB call only if the message is not null
        if (message != null) {
          const response = await transport.sendMessage(message);
          const result = config.getResponseOverride(response);
          resolve(result);
        } else {
          resolve(null);
        }
      });
    });
  });

  /**
   * @module main
   * @function validateCustom
   * @description validate custom string from getting openrpc custom validator function response.
   * @param {*} jsonString - pass in json string to customValidator method
   * @param {*} moduleMethod - get module and method from validation module
   * @param {*} customValidatorName - pass in custom validator name inside validation module object
   * @example
   * cy.validateCustom("<JSON>", "accessibility.closedCaptionsSettings", "validationOne")
   */
  Cypress.Commands.add('validateCustom', (jsonString, moduleMethod, customValidatorName) => {
    return validationModule.validateCustom(jsonString, moduleMethod, customValidatorName);
  });

  /**
   * @module main
   * @function validateJSON
   * @description validate given jsonpath from the string.
   * @param {*} jsonString - json string
   * @param {*} jsonPath - json query path to get validate data from json string
   * @example
   * cy.validateJSON('[{"name": "London", "population": 8615246 }, { "name": "Berlin", "population": 3517424 }]', "$..name")
   */
  Cypress.Commands.add('validateJSON', (jsonString, jsonPath) => {
    return validationModule.validateJSON(jsonString, jsonPath);
  });

  /**
   * @module main
   * @function startTest
   * @description Start the sanity test using datable.
   * @param {Object} datatables - Contains the input variable to override default value to run suite files (Ex: appId, SDK mode)
   * @example
   * startTest({"rawTable": [ ["paramType","variableName","value"], ["INPUT","asynchronous","false"]]})
   */
  Cypress.Commands.add('startTest', (datatables) => {
    const additionalParams = {};
    let overrideParams = {};
    let appId;

    Cypress.env(CONSTANTS.SANITY_REPORT_POLLING_TIMEOUT, CONSTANTS.SANITY_REPORT_LONGPOLL_TIMEOUT);

    // Iterating through the datatables and updating the values to additionalParams object.
    if (datatables) {
      datatables.hashes().forEach((datatable) => {
        if (datatable.paramType == CONSTANTS.INPUT) {
          if (datatable.variableName && datatable.value) {
            additionalParams[datatable.variableName] = datatable.value;
          }
        }
        if (datatable.paramType == CONSTANTS.CONFIG) {
          if (datatable.variableName == CONSTANTS.APP_ID) {
            appId = UTILS.getEnvVariable(datatable.value);
          }
        } else {
          appId = UTILS.getEnvVariable(CONSTANTS.THIRD_PARTY_APP_ID);
        }
      });
    }

    // Overriding default value for mode, if input is not there from feature file or cli.
    const mode = CONSTANTS.MODE_SDK; // default to SDK
    if (
      !additionalParams[CONSTANTS.COMMUNICATION_MODE] &&
      !UTILS.getEnvVariable(CONSTANTS.COMMUNICATION_MODE, false)
    ) {
      additionalParams[CONSTANTS.COMMUNICATION_MODE] = mode;
    } else if (
      (!additionalParams[CONSTANTS.COMMUNICATION_MODE] ||
        additionalParams[CONSTANTS.COMMUNICATION_MODE]) &&
      UTILS.getEnvVariable(CONSTANTS.COMMUNICATION_MODE, false)
    ) {
      additionalParams[CONSTANTS.COMMUNICATION_MODE] = UTILS.getEnvVariable(
        CONSTANTS.COMMUNICATION_MODE
      );
    }

    // Overriding default value for action, if input is not there from feature file or cli.
    const action = CONSTANTS.ACTION_CORE; // default to CORE
    if (!additionalParams[CONSTANTS.ACTION] && !UTILS.getEnvVariable(CONSTANTS.ACTION, false)) {
      additionalParams[CONSTANTS.ACTION] = action;
    } else if (
      (!additionalParams[CONSTANTS.ACTION] || additionalParams[CONSTANTS.ACTION]) &&
      UTILS.getEnvVariable(CONSTANTS.ACTION, false)
    ) {
      additionalParams[CONSTANTS.ACTION] = UTILS.getEnvVariable(CONSTANTS.ACTION);
    }

    overrideParams.certification = UTILS.getEnvVariable(CONSTANTS.CERTIFICATION, false);
    overrideParams.exceptionMethods = UTILS.generateExceptionListForSanity();

    // If certification is true override excluded methods and modules from config module if it is present else use the default lists in constants.
    if (overrideParams.certification == true) {
      overrideParams = UTILS.overideParamsFromConfigModule(overrideParams);
    }

    cy.runIntentAddon(CONSTANTS.TASK.RUNTEST, additionalParams).then((parsedIntent) => {
      const intent = UTILS.createIntentMessage(
        CONSTANTS.TASK.RUNTEST,
        overrideParams,
        parsedIntent
      );
      const requestTopic = UTILS.getTopic(appId);
      const responseTopic = UTILS.getTopic(appId, CONSTANTS.SUBSCRIBE);

      if (!UTILS.getEnvVariable(CONSTANTS.DEVICE_MAC)) {
        cy.log(CONSTANTS.DEVICE_MAC_UNAVAILABLE).then(() => {
          assert(false, CONSTANTS.DEVICE_MAC_UNAVAILABLE);
        });
      }

      cy.sendMessagetoApp(requestTopic, responseTopic, intent).then((response) => {
        cy.log('Response from Firebolt Implementation: ' + response);

        if (response === CONSTANTS.RESPONSE_NOT_FOUND) {
          assert(false, CONSTANTS.NO_MATCHED_RESPONSE);
        } else {
          try {
            response = JSON.parse(response);
          } catch (error) {
            assert(false, error);
          }
          assert.exists(response.report, CONSTANTS.INVALID_RESPONSE);

          // Writing sanity mochawesome json to file when jobId is present.
          if (UTILS.getEnvVariable(CONSTANTS.JOBID, false)) {
            const reportPath = CONSTANTS.SANITY_REPORT_FILE_PATH;
            cy.task(CONSTANTS.WRITE_TO_FILE, {
              fileName: reportPath,
              data: JSON.stringify(response.report),
            });
          }

          cy.generateAndPushReports(response.report);
          Cypress.env(CONSTANTS.SANITY_REPORT_POLLING_TIMEOUT, null);
        }
      });
    });
  });

  /**
   * @module main
   * @function runIntentAddon
   * @description  If there was an add-on function in our config module it will be invoked and added additional fields else it will return the passed intent back.
   * @param {string} command - Add-on function name present in config module.
   * @param {Object} intent - Basic intent message that will applicable to ALL platforms to start the test on FCA.
   * @example
   * runIntentAddon("runTest", {"asynchronous": "false","communicationMode": "SDK","isAsync": false,"action": "CORE"})
   */
  Cypress.Commands.add('runIntentAddon', (command, message) => {
    if (module && module.intentAddons && typeof module.intentAddons[command] === 'function') {
      message = module.intentAddons[command](message);
    }
    // Add-ons not there, returning intent without changes
    return message;
  });

  /**
   * @module main
   * @function sendMessagetoApp
   * @description Publish a message and fetch response from app based on arguments
   * @param {string} requestTopic - Topic used to publish message
   * @param {string} responseTopic - Topic used to subscribe message
   * @param {Object} intent - Basic intent message that will applicable to ALL platforms to start the test on FCA.
   * @example
   * cy.sendMessagetoApp('900218FFD490_appId_FCS',900218FFD490_appId_FCA,{"asynchronous": "false","communicationMode": "SDK","isAsync": false,"action": "search"}, 1000)
   */
  Cypress.Commands.add('sendMessagetoApp', async (requestTopic, responseTopic, intent) => {
    const headers = { id: uuidv4() };

    // If 'sanityReportPollingTimeout' is undefined taking default timeout as 15 seconds.
    const longPollTimeout = UTILS.getEnvVariable(CONSTANTS.SANITY_REPORT_POLLING_TIMEOUT, false)
      ? UTILS.getEnvVariable(CONSTANTS.SANITY_REPORT_POLLING_TIMEOUT)
      : CONSTANTS.LONGPOLL_TIMEOUT;

    // Subscribing to the topic when the topic is not subscribed.
    if (
      responseTopic != undefined &&
      !UTILS.getEnvVariable(CONSTANTS.RESPONSE_TOPIC_LIST).includes(responseTopic)
    ) {
      // Subscribe to topic and pass the results to the callback function
      appTransport.subscribe(responseTopic, subscribeResults);
      UTILS.getEnvVariable(CONSTANTS.RESPONSE_TOPIC_LIST).push(responseTopic);
    }

    if (appTransport) {
      // Publish the message on topic
      appTransport.publish(requestTopic, JSON.stringify(intent), headers);

      // Returns the response after polling when data is available in queue
      return UTILS.getEnvVariable(CONSTANTS.MESSAGE_QUEUE)
        .LongPollQueue(headers.id, longPollTimeout)
        .then((results) => {
          if (results) {
            // Response recieved from queue
            return results;
          }
        });
    } else {
      cy.log(CONSTANTS.APP_TRANSPORT_UNAVAILABLE).then(() => {
        assert(false, CONSTANTS.APP_TRANSPORT_UNAVAILABLE);
      });
    }
  });

  /**
   * @module main
   * @function subscribeResults
   * @description Callback function to fetch the required response from subscribe and push it to a global queue
   * @param {object} data - Response payload from subscribe call
   * @param {object} metaData - Response headers from subscribe call
   * @example
   * subscribeResults('{ "result": { "type": "device", "value": "PD54331.." } }', headers:{id:1232435, client:fca})
   **/
  function subscribeResults(data, metaData) {
    const queueInput = {};
    queueInput.data = data;
    queueInput.metaData = metaData;
    // Push the data and metadata as an object to queue
    UTILS.getEnvVariable(CONSTANTS.MESSAGE_QUEUE).enqueue(queueInput);
  }

  /**
   * @module main
   * @function destroyGlobalObjects
   * @description Destroy global objects and recursively clear the environment variables whose name is stored in the list if present, before test execution. List of names of global object to be cleared can be passed
   *  @param {object} objectNameList - list of objects to be cleared
   *  @example
   * destroyGlobalObjects(['lifecycleAppObjectList'])
   **/
  function destroyGlobalObjects(objectNameList) {
    for (const objectName of objectNameList) {
      const objectListEnv = Cypress.env(objectName);
      for (const appObject in objectListEnv) {
        Cypress.env(objectListEnv[appObject], null);
      }
      Cypress.env(objectName, []);
    }
  }

  /**
   * @module main
   * @function generateAndPushReports
   * @description Generate required reports once test is executed
   * @param {object} jsonObj - JSON response from third party app
   * @example
   * cy.generateAndPushReports(reportJson)
   */
  Cypress.Commands.add('generateAndPushReports', (jsonObj) => {
    if (CONSTANTS.GENERATE_HTML_REPORT) {
      const fileNamePrefix = uuidv4();
      const outputDirectory = defaultDirectory + fileNamePrefix + path.sep;
      const isWritten = writeJsonToFileForReporting(jsonObj, outputDirectory, fileNamePrefix);
      if (isWritten) {
        cy.convertJsonToHTML(outputDirectory, fileNamePrefix + jsonFile).then((isConverted) => {
          if (isConverted) {
            cy.task('log', 'HTML report generated in: ' + defaultDirectory + fileNamePrefix);
          }
        });
      } else {
        cy.log(CONSTANTS.WRITE_FAILED).then(() => {
          assert(false, 'Unable to write report json to file');
        });
      }
    } else {
      console.log(
        'CONSTANTS.GENERATE_HTML_REPORT should be set to true in order to generate html report'
      );
    }
  });

  async function writeJsonToFileForReporting(jsonData, defaultDirectory, fileNamePrefix) {
    const jsonObj = jsonData;
    const jsonContent = JSON.stringify(jsonObj, null, 4);
    const fileName = fileNamePrefix + jsonFile;

    cy.task(CONSTANTS.WRITE_TO_FILE, {
      fileName: defaultDirectory + fileName,
      data: jsonContent,
    }).then((isWritten) => {
      return isWritten;
    });
  }

  // Convert mochawesome json to html report
  Cypress.Commands.add('convertJsonToHTML', (defaultDirectory, fileName) => {
    const command =
      'npx marge ' +
      defaultDirectory +
      fileName +
      ' -f report -t "' +
      'TestSuiteReport' +
      '" -p "' +
      'TestSuiteReport' +
      '" -o ' +
      defaultDirectory;
    try {
      // run command to generate html report
      cy.task(CONSTANTS.EXECUTE_SHELL, command).then((response) => {
        if (response.stdout.includes('Reports saved')) {
          return true;
        }
        console.log(response);
        return false;
      });
    } catch (err) {
      console.log(err);
      return false;
    }
  });

  /**
   * @module main
   * @function testDataHandler
   * @description Fetching and parsing params/content from fixtures
   * @param {*} requestType - Type of request. param or content
   * @param {*} dataIdentifier - Key to be used to fetch param or content data from the fixtures
   * @example
   * cy.testDataHandler("Params","Account_Id");
   * cy.testDataHandler("Content","Device_Id");
   */
  Cypress.Commands.add('testDataHandler', (requestType, dataIdentifier) => {
    const defaultRetVal = dataIdentifier;
    switch (requestType) {
      case CONSTANTS.PARAMS:
        const moduleName = UTILS.extractModuleName(dataIdentifier);

        // Fetching the params from json files based on dataIdentifier.
        cy.testDataParser(requestType, dataIdentifier, moduleName);
        break;
      case CONSTANTS.CONTEXT:
        const contextImportFile = CONSTANTS.CONTEXT_FILE_PATH;

        // Fetching the context value from apiObjectContext json based on dataIdentifier.
        cy.getDataFromTestDataJson(contextImportFile, dataIdentifier, requestType).then(
          (context) => {
            if (context === CONSTANTS.NO_DATA) {
              cy.log(
                `Expected context not found for ${dataIdentifier}. Returning ${dataIdentifier} as is.`
              ).then(() => {
                return defaultRetVal;
              });
            } else {
              return context;
            }
          }
        );
        break;
      case CONSTANTS.CONTENT:
        if (
          typeof dataIdentifier == CONSTANTS.STRING ||
          (dataIdentifier &&
            dataIdentifier.validations &&
            dataIdentifier.validations[0].mode &&
            dataIdentifier.validations[0].mode == CONSTANTS.STATIC_CONTENT_VALIDATION)
        ) {
          // If dataIdentifier is object reading validations[0].type else using dataIdentifier as-is.
          dataIdentifier =
            typeof dataIdentifier == CONSTANTS.OBJECT
              ? dataIdentifier.validations[0].type
              : dataIdentifier;

          const moduleName = UTILS.extractModuleName(dataIdentifier);

          // Fetching the content value from JSON files based on dataIdentifier.
          cy.testDataParser(requestType, dataIdentifier, moduleName);
        } else if (
          dataIdentifier &&
          dataIdentifier.validations &&
          dataIdentifier.validations[0].mode &&
          dataIdentifier.validations[0].mode == CONSTANTS.DEVICE_CONTENT_VALIDATION
        ) {
          let deviceMAC = UTILS.getEnvVariable(CONSTANTS.DEVICE_MAC);
          deviceMAC = deviceMAC.replaceAll(':', '');

          // If <deviceMAC> is present reading the data from the <deviceMAC>.json file. Else, reading it from defaultDeviceData.json
          const deviceDataPath = deviceMAC
            ? CONSTANTS.EXTERNAL_DEVICES_PATH + deviceMAC + '.json'
            : CONSTANTS.DEFAULT_DEVICE_DATA_PATH;

          if (!deviceMAC) {
            cy.log('Falling back to default device data path');
          }

          cy.getDataFromTestDataJson(
            deviceDataPath,
            dataIdentifier.validations[0].type,
            requestType
          ).then((data) => {
            if (data === CONSTANTS.NO_DATA) {
              cy.log(
                `Expected content not found for dataIdentifier.validations[0].type. Returning ${dataIdentifier} as is.`
              ).then(() => {
                return defaultRetVal;
              });
            } else {
              return data;
            }
          });
        } else {
          cy.log(
            `No Content special handling logic for ${dataIdentifier}. Returning ${dataIdentifier} as is.`
          ).then(() => {
            return defaultRetVal;
          });
        }
        break;
      case CONSTANTS.BEFORE_OPERATION:
        cy.getBeforeOperationObject();
        break;
      default:
        cy.log(
          `Expected requestType - ${requestType} to be one of ${CONSTANTS.TEST_DATA_HANDLER_REQUESTTYPE}`
        ).then(() => {
          expect(requestType).to.be.oneOf(CONSTANTS.TEST_DATA_HANDLER_REQUESTTYPE);
        });
    }
  });

  /**
   * @module main
   * @function testDataParser
   * @description Fetching the data from json files based on the priority as shown below
   *   External <module>.json from configModule (If applicable)
   *   Internal <module>.json from fixtures (If applicable)
   *   default.json
   * @param {*} requestType - Type of request. param or content
   * @param {*} dataIdentifier - Key to be used to fetch param or content data from the fixtures
   * @param {String} moduleName - Module file name where data is present.
   * @example
   * cy.testDataParser("Params","Account_Id", "account");
   */
  Cypress.Commands.add('testDataParser', (requestType, dataIdentifier, moduleName) => {
    const defaultImportFile = CONSTANTS.DEFAULT_PATH;
    let defaultRetVal = dataIdentifier;
    if (requestType == CONSTANTS.PARAMS) {
      defaultRetVal = { value: dataIdentifier };
    }

    // Check for the data in defaultTestData.json
    cy.getDataFromTestDataJson(defaultImportFile, dataIdentifier, requestType).then(
      (defaultImportData) => {
        let paramData = defaultImportData;

        // Variables that come from a module will be formatted as '<Module>_<Variable>'
        // Ex: "Device_Model" should go to "Device.json" and look up variable "Model"
        if (dataIdentifier.includes('_')) {
          moduleName = !moduleName ? UTILS.extractModuleName(dataIdentifier) : moduleName;
          dataIdentifier = dataIdentifier.slice(dataIdentifier.indexOf('_') + 1);
          const moduleImportPath = `${CONSTANTS.MODULES_PATH}${moduleName}.json`;
          const externalModulePath = `${CONSTANTS.EXTERNAL_PATH}${moduleName}.json`;

          // Data in modules directory has high priority than defaultTestData, if data is found it will be replaced with data found in defaultTestData.json
          cy.getDataFromTestDataJson(moduleImportPath, dataIdentifier, requestType).then(
            (moduleData) => {
              paramData = moduleData != CONSTANTS.NO_DATA ? moduleData : paramData;

              // Checking the data from the external json file only if it is present.
              cy.task(CONSTANTS.READ_FILES_FROM_DIRECTORY, CONSTANTS.CYPRESS_MODULES_PATH).then(
                (data) => {
                  if (data && data.includes(`${moduleName}.json`)) {
                    // Data in external/modules directory has high priority than defaultTestData and modules, if data is found it will be replaced with data found in modules directry/defaultTestData.json
                    cy.getDataFromTestDataJson(
                      externalModulePath,
                      dataIdentifier,
                      requestType
                    ).then((externalModuleData) => {
                      paramData =
                        externalModuleData != CONSTANTS.NO_DATA ? externalModuleData : paramData;
                      if (paramData == CONSTANTS.NO_DATA) {
                        cy.log(
                          `Expected data ${dataIdentifier} was not found in the default file, FCS module JSON file, or external module JSON file. Returning ${dataIdentifier} as is.`
                        ).then(() => {
                          return defaultRetVal;
                        });
                      } else {
                        return paramData;
                      }
                    });
                  } else {
                    if (paramData == CONSTANTS.NO_DATA) {
                      cy.log(
                        `Expected data ${dataIdentifier} was not found in default file or module JSON file. Returning ${dataIdentifier} as is.`
                      ).then(() => {
                        return defaultRetVal;
                      });
                    } else {
                      return paramData;
                    }
                  }
                }
              );
            }
          );
        } else {
          if (paramData == CONSTANTS.NO_DATA) {
            cy.log(
              `Expected data ${dataIdentifier} was not found in default file. Returning ${dataIdentifier} as is.`
            ).then(() => {
              return defaultRetVal;
            });
          } else {
            return paramData;
          }
        }
      }
    );
  });

  /**
   * @module main
   * @function parseDataFromTestDataJson
   * @description Function to format the data fetched from fixtures
   * @param {*} paramData - JSON data needed to parse based on key.
   * @param {*} dataIdentifier - Key to be used to find value from paramData.
   * @example
   * cy.parseDataFromTestDataJson({"ACCESSIBILITY_CLOSEDCAPTIONS_TRUE":"true"},"ACCESSIBILITY_CLOSEDCAPTIONS_TRUE", "Params")
   */
  function parseDataFromTestDataJson(paramData, dataIdentifier, requestType) {
    let returnData;
    if (requestType == CONSTANTS.PARAMS) {
      if (paramData[dataIdentifier] !== undefined) {
        if (
          typeof paramData[dataIdentifier] == CONSTANTS.STRING ||
          typeof paramData[dataIdentifier] == CONSTANTS.BOOLEAN ||
          typeof paramData[dataIdentifier] == CONSTANTS.NUMBER ||
          paramData[dataIdentifier] === null
        ) {
          returnData = { value: paramData[dataIdentifier] };
        } else {
          returnData = paramData[dataIdentifier];
        }
      }
    } else {
      returnData = paramData[dataIdentifier];
    }

    return returnData;
  }

  /**
   * @module main
   * @function getDataFromTestDataJson
   * @description Command to fetch the data from fixtures and format the fetched data
   * @param {*} modulePath - Path of the json file.
   * @param {*} dataIdentifier - Key to be used to fetch value from the json.
   * @example
   * cy.getDataFromTestDataJson("modules/accessibility.json","ACCESSIBILITY_CLOSEDCAPTIONS_TRUE", "Params")
   */
  Cypress.Commands.add('getDataFromTestDataJson', (modulePath, dataIdentifier, requestType) => {
    cy.task('readFileIfExists', modulePath).then((data) => {
      if (data) {
        data = JSON.parse(data);
        const response = parseDataFromTestDataJson(data, dataIdentifier, requestType);

        if (response !== undefined) {
          return response;
        } else {
          return CONSTANTS.NO_DATA;
        }
      }
      return CONSTANTS.NO_DATA;
    });
  });

  /**
   * @module main
   * @function customValidation
   * @description Command to execute the custom validations in configModule
   * @param {*} functionName - The name of custom validation function
   * @param {*} apiOrEventObject - The response of the method or event
   * @example
   * cy.customValidation("customMethod1","apiResponseObject")
   */

  Cypress.Commands.add('customValidation', (fcsValidationObjectData, apiOrEventObject) => {
    // to check whether validationObject has assertionDef as the field
    if (fcsValidationObjectData && fcsValidationObjectData.assertionDef) {
      const functionName = fcsValidationObjectData.assertionDef;
      // to check whether config module has customValidations function
      if (module && module.customValidations) {
        // to check whether customValidations has a function as the functionName passed
        if (
          module.customValidations[functionName] &&
          typeof module.customValidations[functionName] === 'function'
        ) {
          message = module.customValidations[functionName](apiOrEventObject);
        } else if (
          // if customValidations doesn't have a function as the functionName passed
          !module.customValidations[functionName] ||
          typeof module.customValidations[functionName] != 'function'
        ) {
          assert(
            false,
            `Expected customValidationMethod ${functionName} was not found in the validationFunctions file.`
          );
        }
      } else {
        // if config module doesn't have customValidations function
        assert(
          false,
          `Expected customValidationMethod ${functionName} was not found in the validationFunctions file.`
        );
      }
    } else {
      // if config module doesn't have customValidations function
      assert(false, `Expected customValidationMethod was not found in the validationObject.`);
    }
  });
}
