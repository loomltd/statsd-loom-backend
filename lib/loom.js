/*jslint node: true, white: true, sloppy: true */

/*
 * Flushes stats to Loom (https://www.loomsystems.com).
 *
 * To enable this backend, include 'statsd-loom-backend' in the
 * backends configuration array:
 *
 *   backends: ['statsd-loom-backend']
 *
 * The backend will read the configuration options from the main
 * statsd configuration file under the sub-hash key 'loom'. See the
 * README in this repository for available configuration options.
 */

var   net = require('net'),
     util = require('util'),
url_parse = require('url').parse,
    https = require('https'),
     http = require('http'),
       fs = require('fs'),
   extend = require('extend');
       
var tunnelAgent = null;

var debug, logAll;
var name, period, sourceName, hostName, sourceRegex, includeMetrics, excludeMetrics;

// How long to wait before retrying a failed post, in seconds
var retryDelaySecs = 5;

// Timeout for POSTs, in seconds
var postTimeoutSecs = 4;

var loomStats = {};
var userAgent;
var flushInterval;

// Maximum measurements we send in a single post
var maxBatchSize = 500;

// What epoch interval to align time stamps to (defaults to flush interval)
var snapTime = null;

// Counters as pushed as gauge increments.
var countersAsGauges = true;

// Do we skip publishing internal statsd metrics.
//
var skipInternalMetrics = true;

// Statsd counters reset, we want monotonically increasing
// counters.
var loomCounters = {};

// Do we always suffix 100 percentile with .100
// e.g. metric_name.100
var alwaysSuffixPercentile = false;

// A string to prepend to all measurement names sent to Librato.
var globalPrefix = "";

// Librato web service can't ignore individual broken metrics
// instead it's dropping whole payloads
// So we place such metrics to stoplist
var brokenMetrics = {};

// Global Measurement tags
var tags = {};

var post_payload = function(options, proto, payload, retry) {
  if (logAll) {
    util.log("Sending Payload: " + payload);
  }
    
  var req = proto.request(options, function(res) {
    res.on('data', function(d) {
      // Retry 5xx codes
      if (Math.floor(res.statusCode / 100) == 5){
        var errdata = "HTTP " + res.statusCode + ": " + d;
        if (retry){
          if (logAll) {
            util.log("Failed to post to Loom: " + errdata, "LOG_ERR");
          }
          setTimeout(function() {
            post_payload(options, proto, payload, false);
          }, retryDelaySecs * 1000);
        } else {
          util.log("Failed to connect to Loom: " + errdata, "LOG_ERR");
        }
      }

      // Log 4xx errors
      if (Math.floor(res.statusCode / 100) == 4){
        var errdata = "HTTP " + res.statusCode + ": " + d;
        if (logAll) {
          util.log("Failed to post to Loom: " + errdata, "LOG_ERR");
        }
        if (/^application\/json/.test(res.headers['content-type'])) {
          var meta = JSON.parse(d),
              re = /'([^']+)' is a \S+, but was submitted as different type/;
          if (meta.errors && meta.errors.params && meta.errors.params.type && meta.errors.params.type.length) {
            var fields = meta.errors.params.type;
            for (var i=0; i < fields.length; i++) {
              var match  = re.exec(fields[i]),
                  field = match && match[1];
              if (field && !brokenMetrics[field]) {
                brokenMetrics[field] = true;
                if (logAll) {
                  util.log(
                    "Placing metric '" + field + "' to stoplist until service restart",
                    "LOG_ERR"
                  );
                }
              }
            }
          }
        }
      }
    });
  });

  req.setTimeout(postTimeoutSecs * 1000, function(request) {
    if (logAll) {
      util.log("Timed out sending metrics to Loom", "LOG_ERR");
    }
    req.end();
  });
  req.write(payload);
  req.end();

  loomStats['last_flush'] = Math.round(new Date().getTime() / 1000);
  req.on('error', function(errdata) {
    if (retry){
      setTimeout(function() {
        post_payload(options, proto, payload, false);
      }, retryDelaySecs * 1000);
    } else {
      util.log("Failed to connect to Loom: " + errdata, "LOG_ERR");
    }
  });
};

var post_metrics = function(ts, gauges, counters, measurements) {
  var payload = {};
  var parsed_host = url_parse('https://' + name + '-data.loomsystems.com');
  
  payload = {
    time: ts,
    tags: tags,
    measurements: measurements
  };
  
  payload = JSON.stringify(payload);

  var options = {
    host: parsed_host["hostname"],
    port: parsed_host["port"] || 443,
    path: '/',
    method: 'POST',
    headers: {
      "Content-Length": payload.length,
      "Content-Type": "application/json",
      "User-Agent" : userAgent
    }
  };

  if (tunnelAgent) {
   options["agent"] = tunnelAgent;
  }

  var proto = http;
  if ((parsed_host["protocol"] || 'http:').match(/https/)) {
    proto = https;
  }

  post_payload(options, proto, payload, true);
};

var sanitize_name = function(name) {
  return name.replace(/[^-.:_\w]+/g, '_').substr(0,255)
};

var timer_gauge_pct = function(timer_name, values, pct, suffix) {
  var thresholdIndex = Math.round(((100 - pct) / 100) * values.length);
  var numInThreshold = values.length - thresholdIndex;

  if (numInThreshold <= 0) {
    return null;
  }

  var max = values[numInThreshold - 1];
  var min = values[0];

  var sum = 0;
  var names = timer_name.split("#");
  var name;

  if (names.length > 1) {
    // We have tags in the timer name i.e. foo#bar=1,baz=2
    // Take the name before the # so we don't screw up the tag values with the percentile suffix
    name = names[0];
  } else {
    // No tags exist in the timer name
    name = timer_name;
  }

  if (suffix) {
    name += suffix;
  }

  // Rejoin everything back together if we had tags
  if (names.length > 1) {
    names[0] = name + "#";
    name = names.join();
  } 

  return {
    name: name,
    count: numInThreshold,
    sum: sum,
    min: min,
    max: max
  };
}

var flush_stats = function librato_flush(ts, metrics) {
  var numStats = 0, statCount;
  var key;
  
  // Librato SD Metrics
  var counters = [];
  var gauges = [];
  
  // Librato MD Metrics
  var measurements = []; 
  
  var measureTime = ts;
  var internalStatsdRe = /^statsd\./;


  if (snapTime) {
    measureTime = Math.floor(ts / snapTime) * snapTime;
  }

  var excludeMetric = function (metric) {
      var matchesFilter = false;
      for (var index = 0; index < includeMetrics.length; index++) {
          if (includeMetrics[index].test(metric)) {
              matchesFilter = true;
              break;
          }
      }

      var matchesExclude = false;
      for (var index = 0; index < excludeMetrics.length; index++) {
          if (excludeMetrics[index].test(metric)) {
              matchesExclude = true;
              break;
          }
      }

      return ((includeMetrics.length > 0) && !matchesFilter) || matchesExclude;
  }

  var addMeasure = function add_measure(mType, measure, countStat) {
    countStat = typeof countStat !== 'undefined' ? countStat : true;
    
    var match;
    var measureName = globalPrefix + measure.name;
    
    measure.tags = {};
    measureName = parse_and_set_tags(measureName, measure);

    // Use first capturing group as source name
    if (sourceRegex && (match = measureName.match(sourceRegex)) && match[1]) {
      measure.source = sanitize_name(match[1]);
      // Remove entire matching string from the measure name & add global prefix.
      measure.name = sanitize_name(measureName.slice(0, match.index) + measureName.slice(match.index + match[0].length));

      // Create a measurement-level tag named source
      measure.tags.source = measure.source;
    } else {
      measure.name = sanitize_name(measureName);

      // Use the global config sourceName as a source tag, if it exists.
      if (sourceName !== null) {
        measure.tags.source = sourceName;
      }
    }

    if (brokenMetrics[measure.name]) {
      return;
    }
    
    measurements.push(measure);
    
    // Post measurements and clear arrays if past batch size
    if (measurements >= maxBatchSize) {
      post_metrics(measureTime, gauges, counters, measurements);
      
      if (measurements >= maxBatchSize) {
        measurements = [];
      }
      
      if (counters.length + gauges.length >= maxBatchSize) {
        gauges = [];
        counters = [];
      }
    }
  };
  
  var parse_and_set_tags = function (measureName, measure) {
    // Valid format for parsing tags out: global-prefix.name#tag1=value,tag2=value
    // NOTE: Name can include the source
    var vals = measureName.split("#")
    if (vals.length > 1) {
      // Found tags in the measureName. Parse them out and return the measureName without the tags.
      measureName = vals.shift();
      rawTags = vals.pop().split(",");
      rawTags.forEach(function(rawTag) {
        var name = rawTag.split("=").shift();
        var value = rawTag.split("=").pop();
        if (name.length && value.length) {
          measure.tags[name] = value;
        }
      });
      
      return measureName;
    } else {
      // No tags existed in the measureName
      return measureName;
    }
  }
  
  for (key in metrics.counters) {
    if (skipInternalMetrics && (key.match(internalStatsdRe) != null)) {
      continue;
    }
    if (excludeMetric(key)) {
      continue;
    }

    if (countersAsGauges) {
      addMeasure('gauge', { name: key,
                            value: metrics.counters[key]});
      continue;
    }

    if (!loomCounters[key]) {
      loomCounters[key] = {value: metrics.counters[key],
                              lastUpdate: ts};
    } else {
      loomCounters[key].value += metrics.counters[key];
      loomCounters[key].lastUpdate = ts;
    }

    addMeasure('counter', { name: key,
                            value: loomCounters[key].value});
  }

  for (key in metrics.timers) {
    if (metrics.timers[key].length == 0) {
      continue;
    }
    if (skipInternalMetrics && (key.match(internalStatsdRe) != null)) {
      continue;
    }
    if (excludeMetric(key)) {
      continue;
    }

    var sortedVals = metrics.timers[key].sort(
      function (a, b) { return a - b; }
    );


    // First build the 100% percentile
    var gauge = timer_gauge_pct(
      key,
      sortedVals,
      100,
      alwaysSuffixPercentile ? '.100' : null
    );

    if (gauge) {
      addMeasure('gauge', gauge);
    }

    // Now for each percentile
    var pKey;
    for (pKey in metrics.pctThreshold) {
      var pct = metrics.pctThreshold[pKey];

      gauge = timer_gauge_pct(key, sortedVals, pct, "." + pct);
      if (gauge) {
        // Percentiles are not counted in numStats
        addMeasure('gauge', gauge, false);
      }
    }

    var timer_data = metrics.timer_data[key];
    if (timer_data != null) {
      var histogram = timer_data.histogram;
      if (histogram != null) {
        var bin;
        for (bin in histogram) {
          var name = key + '.' + bin;
          // Bins are not counted in numStats
          addMeasure('gauge', { name: name,
                                value: histogram[bin]}, false);
        }
      }
    }
  }

  for (key in metrics.gauges) {
    if (skipInternalMetrics && (key.match(internalStatsdRe) != null)) {
      continue;
    }
    if (excludeMetric(key)) {
      continue;
    }

    addMeasure('gauge', { name: key,
                          value: metrics.gauges[key]});
  }

  for (key in metrics.sets) {
    if (skipInternalMetrics && (key.match(internalStatsdRe) != null)) {
      continue;
    }

    addMeasure('gauge', { name: key,
                          value: metrics.sets[key].values().length });
  }

  statCount = numStats;

  if (!skipInternalMetrics) {
    if (countersAsGauges) {
      addMeasure('gauge', { name: 'numStats',
                            value: statCount});
    } else {
      if (loomCounters['numStats']) {
        loomCounters['numStats'].value += statCount;
        loomCounters['numStats'].lastUpdate = ts;
      } else {
        loomCounters['numStats'] = {value: statCount,
                                       lastUpdate: ts};
      }

      addMeasure('counter', { name: 'numStats',
                              value: loomCounters['numStats'].value});
    }
  }
  
  if (gauges.length > 0 || counters.length > 0 || measurements.length > 0) {
    post_metrics(measureTime, gauges, counters, measurements);
  }

};

var backend_status = function loom_status(writeCb) {
  for (stat in loomStats) {
    writeCb(null, 'loom', stat, loomStats[stat]);
  }
};

var build_user_agent = function() {
  var str;
  var version = "unknown";

  try {
    str = fs.readFileSync(__dirname + '/../package.json', 'UTF-8');
    json = JSON.parse(str);
    version = json['version'];
  } catch (e) {
    if (logAll) {
      util.log(e);
    }
  }

  return "statsd-loom-backend/" + version;
}

var convert_string_to_regex = function (stringRegex) {
    // XXX: Converting to Regexp will add another enclosing '//'
    if (stringRegex.length > 2 && stringRegex[0] == '/' &&
        stringRegex[stringRegex.length - 1] == '/') {
        return new RegExp(stringRegex.slice(1, stringRegex.length - 1));
    } else {
        return new RegExp(stringRegex);
    }
}

exports.init = function loom_init(startup_time, config, events, logger) {
  logAll = debug = config.debug;

  if (typeof logger !== 'undefined') {
    util = logger; // override the default
    logAll = true;
  }

  // Config options are nested under the top-level 'loom' hash
  if (config.loom) {
    name = config.loom.name;
    sourceName = config.loom.source;
    hostName = config.loom.host;
    sourceRegex = config.loom.sourceRegex;
    snapTime = config.loom.snapTime;
    includeMetrics = config.loom.includeMetrics;
    excludeMetrics = config.loom.excludeMetrics;

    // Handle the sourceRegex as a string
    if (typeof sourceRegex == 'string') {
      sourceRegex = convert_string_to_regex(sourceRegex);
    }

    if (!Array.isArray(includeMetrics)) {
      includeMetrics = [];
    }

    for (var index = 0; index < includeMetrics.length; index++) {
      if (typeof includeMetrics[index] == 'string') {
        includeMetrics[index] = convert_string_to_regex(includeMetrics[index]);
      }
    }

    if (!Array.isArray(excludeMetrics)) {
      excludeMetrics = [];
    }

    for (var index = 0; index < excludeMetrics.length; index++) {
      if (typeof excludeMetrics[index] == 'string') {
        excludeMetrics[index] = convert_string_to_regex(excludeMetrics[index]);
      }
    }

    if (config.loom.countersAsGauges != null) {
      countersAsGauges = config.loom.countersAsGauges;
    }

    if (config.loom.skipInternalMetrics != null) {
      skipInternalMetrics = config.loom.skipInternalMetrics;
    }

    if (hostName == null) {
      var os = require('os');

      hostName = os.hostname();
    }

    if (config.loom.proxy && config.loom.proxy.uri) {

      var tunnelFunc;
      try {
          tunnelFunc = require('https-proxy-agent');
      } catch(e) {
           util.log("Cannot find module 'https-proxy-agent'.", "LOG_CRIT");
           util.log("Make sure to run `npm install https-proxy-agent`.", "LOG_CRIT");
           return false;
      }

      tunnelAgent = new tunnelFunc( config.loom.proxy.uri );
    }

    if (config.loom.retryDelaySecs) {
      retryDelaySecs = config.loom.retryDelaySecs;
    }

    if (config.loom.postTimeoutSecs) {
      postTimeoutSecs = config.loom.postTimeoutSecs;
    }

    if (config.loom.batchSize) {
      maxBatchSize = config.loom.batchSize;
    }

    if(config.loom.alwaysSuffixPercentile) {
      alwaysSuffixPercentile = config.loom.alwaysSuffixPercentile;
    }

    if(config.loom.globalPrefix) {
      globalPrefix = config.loom.globalPrefix + '.';
    }
    
    // Set global measurement tags if they are defined.
    if (config.loom.tags && Object.keys(config.loom.tags).length) {
      tags = config.loom.tags;
    }
    
    // Set host as a global tag. Defaults to os.hostname(). Can be disabled by setting host to false.
    if (hostName) {
      tags.host = hostName;
    }
  }

  if (!name) {
    util.log("Invalid configuration for Loom backend", "LOG_CRIT");
    return false;
  }

  flushInterval = config.flushInterval;

  if (!snapTime) {
    snapTime = Math.floor(flushInterval / 1000);
  }

  userAgent = build_user_agent();

  events.on('flush', flush_stats);
  events.on('status', backend_status);

  return true;
};
