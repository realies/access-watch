/**
 * Stream processing language.
 *
 * An event is an immutable map with the following keys:
 *
 *  time  int     required   Number of seconds since UNIX epoch.
 *  data  any     required   An event's data.
 *  key   string  optional   A way to group events together
 *
 * This modules provides functions to build a pipeline, a tree of stream processors.
 */
const Ajv = require('ajv')
const { Map, List } = require('immutable')
const { now, complement, iso } = require('./util')
const { Speed } = require('./speed')

const session = require('./session').connect('aw:file://sessions')
const metrics = require('./metrics').connect('aw:file://metrics')

const schema = require('../format/log-schema.json')
const validator = new Ajv()
const validate = validator.compile(schema)

// Basic "error stream", we might want to do something more sophisticated here
const onError = error => {
  console.log(error)
  if (error.has('reason')) {
    console.trace(error.get('reason'))
  }
}

/**
 * Build an error event and send it to the error stream.
 *
 * Optionally takes the `event` that caused the error.
 */
function error (reason, event) {
  let errorEvent = Map({
    name: 'error',
    time: now(),
    reason: reason
  })
  if (event) {
    errorEvent = errorEvent.set('event', event)
  }
  onError(errorEvent)
}

/**
 * Print `f(event)` to the console and return event.
 */
function trace (f) {
  return (stream) => {
    return (event) => {
      console.log(JSON.stringify(f(event), null, 2))
      forward(stream, event)
    }
  }
}

/**
 * Forward an event to a stream.
 */
function forward (stream, event) {
  try {
    stream(event)
  } catch (reason) {
    error(reason, event)
  }
}

/**
 * Identity stream transformer.
 */
function identity () {
  return (stream) => stream
}

/**
 * Applies `f` to each event.
 *
 * `f` can return an event or a Promise of an event.
 */
function map (f) {
  return (stream) => {
    return (event) => {
      const res = f(event.get('data'))
      if (res && res.then) {
        res
          .then(value => forward(stream, event.set('data', value)))
          .catch(reason => error(reason, event))
      } else {
        forward(stream, event.set('data', res))
      }
    }
  }
}

/**
 * Forward events if `pred(event)` returns true.
 */
function filter (pred) {
  return (stream) => {
    return (event) => {
      if (pred(event.get('data'))) {
        forward(stream, event)
      }
    }
  }
}

/**
 * Compose stream transformers sequentially.
 */
function comp (xfes) {
  const xfes_ = xfes.slice().reverse()
  return (stream) => {
    return xfes_.reduce((stream, xf) => xf(stream), stream)
  }
}

/**
 * Compose stream transformers in parallel.
 */
function multiplex (xfes) {
  return (stream) => {
    const streams = xfes.map(xf => xf(stream))
    return (event) => {
      streams.map(stream => forward(stream, event))
    }
  }
}

/**
 * Logically split the stream for each unique value of `f(event)`.
 *
 * Ignore `undefined` values.
 */
function by (f) {
  return (stream) => {
    return (event) => {
      const value = f(event.get('data'))
      if (value !== undefined) {
        forward(stream, event.set('key', value))
      }
    }
  }
}

// Holds the state of the windows
let windows = List()
let id = 0
const nextId = () => id++

/**
 * Group events according to a window strategy and apply a reducer to each window.
 *
 * If the stream is split (`by` was called), maintain a different window for each key.
 */
function window ({strategy, reducer, allowedLateness, fireEvery, watermarkDelay}) {
  const id = nextId()
  return (stream) => {
    return (event) => {
      // Drop late events
      const t = event.get('time')
      const watermark = now() - watermarkDelay
      if (t < watermark - allowedLateness) {
        console.log('WARNING', 'Dropping late event.')
        console.log('Watermark:', iso(watermark), 'Event time:', iso(t), 'Delta:', t - watermark)
        return
      }
      windows = windows.updateIn([id, event.get('key')], Map(), windows => {
        // assign event to windows
        let eventWindows = strategy.assign(event)
        // update windows
        windows = eventWindows.reduce((windows, window) => {
          return windows.update(window.get('start') + ':' + window.get('end'),
                                window.set('acc', reducer.init()),
                                w => {
                                  return w
                                    .update('acc', acc => reducer.step(acc, event.get('data')))
                                    .set('triggered', false)
                                })
        }, windows)
        // trigger windows (FIXME: Move this logic out of this function)
        windows = windows.map(window => {
          if (fireEvery && watermark < window.get('end') &&
              (watermark - window.get('lastFired', window.get('start'))) >= fireEvery) {
            forward(stream, Map({
              time: window.get('start'),
              data: reducer.result(window.get('acc')),
              key: event.get('key')
            }))
            return window.set('lastFired', watermark)
          }
          if ((window.get('end') <= watermark) && !window.get('triggered')) {
            forward(stream, Map({
              time: window.get('start'),
              data: reducer.result(window.get('acc')),
              key: event.get('key')
            }))
            return window.set('triggered', true)
          }
          return window
        })
        // Garbage collect windows
        return windows.filter(window => window.get('end') >= watermark - allowedLateness)
      })
    }
  }
}

/**
 * Add a metric to the store.
 */
function store () {
  return (stream) => {
    return (event) => {
      metrics.add(event.get('data').set('time', event.get('time')))
      return event
    }
  }
}

/**
 * Assign a session to the log event, create it if necessary.
 */
function sessionHandler ({type, gap, id}) {
  return (stream) => {
    return (event) => {
      const sessId = id(event.get('data'))
      if (sessId !== undefined) {
        const sess = session.assign({type: type, id: sessId, time: event.get('time'), gap: gap})
        stream(event.setIn(['data', 'session'], sess))
      }
    }
  }
}

/**
 * Pipeline builder
 */
class Builder {
  constructor (xf) {
    this.xf = xf
    this.children = []
    this.watermarkDelay = 5
    this.allowedLateness = 60
  }

  add (xf) {
    const child = new Builder(xf)
    this.children.push(child)
    return child
  }

  map (f) {
    return this.add(map(f))
  }

  filter (pred) {
    return this.add(filter(pred))
  }

  split (pred) {
    return [
      this.add(filter(pred)),
      this.add(filter(complement(pred)))
    ]
  }

  by (f) {
    return this.add(by(f))
  }

  metrics (f) {
    return this
      .map(f)
      .by(metrics.encodeSeries)
  }

  store () {
    return this.add(store())
  }

  session (opts) {
    return this.add(sessionHandler(opts))
  }

  window (opts) {
    if (!opts.watermarkDelay) {
      opts.watermarkDelay = this.watermarkDelay
    }
    if (!opts.allowedLateness) {
      opts.allowedLateness = this.allowedLateness
    }
    return this.add(window(opts))
  }

  trace (f = e => e) {
    return this.add(trace(f))
  }

  create () {
    if (this.children.length === 0) {
      return this.xf
    }
    return comp([this.xf, multiplex(this.children.map(b => b.create()))])
  }
}

class Pipeline extends Builder {
  constructor () {
    super(identity())
    this.inputs = []
    this.monitors = []
    this.stream = null
  }

  registerInput (input) {
    this.inputs.push(input)
    this.monitors.push({
      accepted: {
        per_minute: new Speed(60, 15),
        per_hour: new Speed(3600, 24)
      },
      rejected: {
        per_minute: new Speed(60, 15),
        per_hour: new Speed(3600, 24)
      },
      status: 'Not started'
    })
  }

  start () {
    this.stream = super.create()(e => {})
    var pipeline = this
    this.inputs.map(function (input, idx) {
      input.start({
        success: function (log) {
          const valid = validate(log.toJS())
          if (valid) {
            const event = Map({
              time: Math.floor(new Date(log.getIn(['request', 'time'])).getTime() / 1000),
              data: log
            })
            pipeline.monitors[idx].accepted.per_minute.hit(event.get('time'))
            pipeline.monitors[idx].accepted.per_hour.hit(event.get('time'))
            pipeline.handleEvent(event)
          } else {
            pipeline.monitors[idx].rejected.per_minute.hit(now())
            pipeline.monitors[idx].rejected.per_hour.hit(now())
            pipeline.handleError(new Error(`Invalid message: ${validator.errorsText(validate.errors)}`))
          }
        },
        error: function (error) {
          pipeline.monitors[idx].rejected.per_minute.hit(now())
          pipeline.monitors[idx].rejected.per_hour.hit(now())
          pipeline.handleError(error)
        },
        status: function (err, msg) {
          if (err) {
            console.error(err)
          }
          console.log(input.name + ': ' + msg)
          pipeline.monitors[idx].status = msg
        }
      })
    })
  }

  handleEvent (event) {
    forward(this.stream, event)
  }

  handleError (err) {
    error(err)
  }

  monitoring () {
    return this.monitors.map((monitor, idx) => {
      return Map(monitor)
        .set('name', this.inputs[idx].name)
        .updateIn(['accepted', 'per_minute'], s => s.compute())
        .updateIn(['accepted', 'per_hour'], s => s.compute())
        .updateIn(['rejected', 'per_minute'], s => s.compute())
        .updateIn(['rejected', 'per_hour'], s => s.compute())
    })
  }
}

module.exports = new Pipeline()
