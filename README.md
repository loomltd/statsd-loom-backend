# StatsD Loom backend

## Overview

This is a pluggable backend for [StatsD][statsd], which
publishes stats to [Loom](https://www.loomsystems.com). 

## Requirements

* [StatsD][statsd] versions >= 0.6.0.
* An active [Loom](https://www.loomsystems.com/free-trial) account

## Installation

    $ cd /path/to/statsd
    $ npm install statsd-loom-backend

## Configuration

You will need to add the following to your StatsD config file.

```js
loom: {
  name:  "name", // as appears in the domain name you use to access Loom, i.e. <this>.loomsystems.com
}
```

Example Full Configuration File:

```js
{
  loom: {
    name:  "name"
  }
  , backends: ["statsd-loom-backend"]
  , port: 8125
  , keyNameSanitize: false
}
```

## Enabling

Add the `statsd-loom-backend` backend to the list of StatsD
backends in the StatsD configuration file:

```js
{
  backends: ["statsd-loom-backend"]
}
```

Start/restart the statsd daemon and your StatsD metrics should now be
pushed to your Loom account.


## Additional configuration options

The Loom backend also supports the following optional configuration
options under the top-level `loom` hash:

* `snapTime`: Measurement timestamps are snapped to this interval
              (specified in seconds). This makes it easier to align
              measurements sent from multiple statsd instances on a
              single graph. Default is to use the flush interval time.

* `countersAsGauges`: A boolean that controls whether StatsD counters
                      are sent to Loom as gauge values (default) or
                      as counters. When set to true (default), the
                      backend will send the aggregate value of all
                      increment/decrement operations during a flush
                      period as a gauge measurement to Loom.

                      When set to false, the backend will track the
                      running value of all counters and submit the
                      current absolute value to Loom as a
                      counter. This will require some additional
                      memory overhead and processing time to track the
                      running value of all counters.

* `skipInternalMetrics`: Boolean of whether to skip publishing of
                         internal statsd metrics. This includes all
                         metrics beginning with 'statsd.' and the
                         metric numStats. Defaults to true, implying
                         they are not sent.

* `retryDelaySecs`: How long to wait before retrying a failed
                    request, in seconds.

* `postTimeoutSecs`: Max time for POST requests to Loom, in
                     seconds.

* `includeMetrics`: An array of JavaScript regular expressions. Only metrics
                    that match any of the regular expressions will be sent to Loom.
                    Defaults to an empty array.

```js
{
   includeMetrics: [/^my\.included\.metrics/, /^my.specifically.included.metric$/]
}
```

* `excludeMetrics`: An array of JavaScript regular expressions. Metrics which match
                    any of the regular expressions will NOT be sent to Loom. If includedMetrics
                    is specified, then patterns will be matched against the resulting
                    list of included metrics.
                    Defaults to an empty array.

              Metrics which are sent to StatsDThis will exclude metrics sent to StatsD so that metrics which
              match the specified regex value

```js
{
   excludeMetrics: [/^my\.excluded\.metrics/, /^my.specifically.excluded.metric$/]
}
```

* `globalPrefix`: A string to prepend to all measurement names sent to Loom. If set, a dot
                  will automatically be added as separator between prefix and measurement name.

## Reducing published data for inactive stats

By default StatsD will push a zero value for any counter that does not
receive an update during a flush interval. Similarly, it will continue
to push the last seen value of any gauge that hasn't received an
update during the flush interval. This is required for some backend
systems that can not handle sporadic metric reports and therefore
require a fixed frequency of incoming metrics. However, it requires
StatsD to track all known gauges and counters and means that published
payloads are inflated with zero-fill data.

Loom can handle sporadic metric publishing at non-fixed
frequencies. Any "zero filling" of graphs is handled at display time
on the frontend. Therefore, when using the Loom backend it is
beneficial for bandwidth and measurement-pricing costs to reduce the
amount of data sent to Loom. In the StatsD configuration file it is
recommended that you enable the following top-level configuration
directive to reduce the amount of zero-fill data StatsD sends:

```json
{
   deleteIdleStats: true
}
```

## Publishing to Graphite and Loom simultaneously

You can push metrics to Graphite and Loom simultaneously. Just include both backends in the `backends`
variable:

```js
{
  backends: [ "./backends/graphite", "statsd-loom-backend" ],
  ...
}
```

See the [statsd][statsd] manpage for more information.

## Using Proxy

If you want to use statsd-loom-backend througth a proxy you should
install **https-proxy-agent** module:

        $npm install https-proxy-agent

After that you should add the *proxy* config to the StatsD config file
in the loom configuration section:

```js
{
  "loom" : {
    "proxy" : {
      "uri" : "http://127.0.0.01:8080"
    }
  }
}
```

That configuration will proxy requests via a proxy listening on
localhost on port 8080. You can also use an https proxy by setting the
protocol to https in the URI.

## Tags

Our backend plugin offers basic tagging support for your metrics you submit to Loom. You can specify what tags you want to submit to Loom using the *tags*
config in the loom configuration section of the StatsD config file:


```js
{
  "loom" : {
    "tags": { "os" : "ubuntu", "host" : "production-web-server-1", ... }
  }
}
```

Once your config has been updated, all metrics submitted to Loom will include your defined tags.


We also support tags at the per-stat level should you need more detailed tagging. We provide a naming syntax for your stats so you can submit tags for each stat. That syntax is as follows:

```
metric.name#tag1=value,tag2=value:value
```

Starting with a `#`, you would pass in a comma-separated list of tags and we will parse out the tags and values. Given the above example, a stat matching
the above syntax will be submitted as metric to Loom with a name of `metric.name`, a value of `value` and with the tags `tag1=value` and `tag2=value. You are welcome to use any statsd client of your choosing.

Please note that in order to use tags, the statsd config option `keyNameSanitize` must be set to `false` to properly parse tags out of your stat name.

[statsd]: https://github.com/etsy/statsd
