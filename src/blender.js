/**
 * @type {{frame: number, memory_global: number, render_time: number, remaining_time?: number, memory_current: number, memory_current_peak: number, scene: string, render_layer: string, information: string, extra_information?: string}}
 */
const blenderOutput = null

const consts = require('./consts')
const { existsSync } = require('fs')
const { spawn, spawnSync } = require('child_process')
const moment = require('moment')
/**
 * @type {{blenderExec: string}}
 */
const config = require(consts.ROOT_DIR + '/config.json')

const { log, assert } = require('./utils')

assert(config.hasOwnProperty('blenderExec'), 1, 'Invalid config file: missing "blenderExec"')
assert(existsSync(config.blenderExec), 2, `"${config.blenderExec}" does not exist`)

const getDataScript = consts.ROOT_DIR + '/python/get_data.py'
const renderScript = consts.ROOT_DIR + '/python/render.py'
const getDevicesScript = consts.ROOT_DIR + '/python/get_devices.py'

const getDataScriptPrefix = 'render_farm_data='

/**
 * Regular expression to parse the blender output when rendering
 */
const blenderLineRegExp = new RegExp(/^Fra:(?<frame>\d+) Mem:(?<memory_global>\d+(.\d+)?)M \(.+\) \| Time:(?<render_time>\d{2}:\d{2}\.\d{2}) \|( Remaining:(?<remaining_time>\d{2}:\d{2}\.\d{2}) \|)? Mem:(?<memory_current>\d+\.\d{2})M, Peak:(?<memory_current_peak>\d+\.\d{2})M \| (?<scene>[^\|]+), (?<render_layer>[^\|]+) \| (?<information>[^\|]+)( \| (?<extra_information>.+))?$/)

/**
 * Turn a blender time string 00:00.00 into a number of milliseconds
 *
 * @param {string} timeString the time string
 * @returns {number} the number of milliseconds
 * @pure
 */
function parseBlenderTime(timeString)
{
  return moment.duration(`00:${timeString}`).asMilliseconds()
}


/**
 * Parse a single blender output line for relevent render data into JSON
 * @param {string} line the stripped blender output line
 * @returns {null | typeof blenderOutput} the blender render data as JSON or null if the line didn't contain render data
 * @pure
 */
function parseBlenderOutputLine(line)
{
    const output = blenderLineRegExp.exec(line)
    if (output === null) return null

    return {
      frame: parseInt(output.groups.frame),
      memory_global: parseFloat(output.groups.memory_global),
      render_time: parseBlenderTime(output.groups.render_time),
      remaining_time: output.groups.remaining_time === undefined ? undefined : parseBlenderTime(output.groups.remaining_time),
      memory_current: parseFloat(output.groups.memory_current),
      memory_current_peak: parseFloat(output.groups.memory_current_peak),
      scene: output.groups.scene,
      render_layer: output.groups.render_layer,
      information: output.groups.information,
      extra_information: output.groups.extra_information
    }
}


/**
 * Get the number of devices present on the system for blender render in sync
 *
 * @returns {number} the number of devices
 * @unpure
 */
function getDevices()
{
  const child = spawnSync(config.blenderExec, [ '-b', '-P', getDevicesScript ])

  const lines = child.stdout.toString().split('\n')

  for (const line of lines) {
    if (!line.startsWith(getDataScriptPrefix)) continue

    const json = JSON.parse(line.split(getDataScriptPrefix)[1])
    return json
  }

  throw 'invalid stdout'
}


/**
 * Get data about the blend file
 *
 * @param {string} blendFile path to the blend file to retrieve data from
 * @returns {Promise<{startFrame: number, endFrame: number}>} some data about the blend file
 * @unpure
 */
function getData(blendFile)
{
  return new Promise((resolve, reject) =>
  {
    const child = spawn(config.blenderExec, [ '-b', blendFile, '-P', getDataScript ])

    child.stdout.on('data', data =>
    {
      const lines = data.toString().split('\n')

      for (const line of lines) {
        if (!line.startsWith(getDataScriptPrefix)) continue

        const json = JSON.parse(line.split(getDataScriptPrefix)[1])
        child.kill()
        return resolve(json)
      }

      return reject('invalid stdout')
    })

    child.on('error', reject)
  })
}

/**
 * Render the given blend file
 *
 * @param {string} blendFile path to the blend file to render
 * @param {{type: 'still' | 'animation', devices: number[], outputFolder: string}} params the parameters to pass to blender
 *
 * type: the type of render to performe
 *
 * devices: the Cycles device ids to use
 *
 * outputFolder:  path to the folder in which to write the frames
 *
 * @param {(progress: {frame: typeof blenderOutput}) => void} onprogress a callback executed when the blend file yields progress
 * @returns {Promise<void>} nothing
 * @unpure
 */
function render(blendFile, params, onprogress)
{
  return new Promise((resolve, reject) =>
  {
    const child = spawn(config.blenderExec, [ '-b', blendFile, '-P', renderScript, '--', JSON.stringify(params) ])

    child.stdout.on('data', data =>
    {
      const lines = data.toString().split('\n').filter(Boolean)

      lines.forEach(line =>
      {
        const output = parseBlenderOutputLine(line)
        if (output !== null) onprogress(output)
      })
    })

    child.on('error', reject)

    child.on('close', (code, signal) =>
    {
      if (code !== 0) return reject(signal)
      return resolve()
    })
  })
}

module.exports = {
  getData,
  getDevices,
  render,
  blenderOutput,
}