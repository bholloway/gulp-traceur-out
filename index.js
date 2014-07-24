var child = require('child_process');
var path = require('path');

var through = require('through2');
var throughPipes = require('through-pipes');
var minimatch = require('minimatch');
var gulp = require('gulp');
var gutil = require('gulp-util');
var inject = require('gulp-inject');
var slash = require('gulp-slash');

module.exports = function(temp) {
  'use strict';
  var sourceTracking = trackSources();
  var outputPath     = temp;
  return {
    sources: function() {
      return throughPipes(function(readable) {
        return readable
          .pipe(slash())
          .pipe(sourceTracking.before())
          .pipe(gulp.dest(temp))
          .pipe(slash())
          .pipe(sourceTracking.after());
      });
    },
    transpile: function() {
      return transpileES6(outputPath);
    },
    jsHintReporter: jsHintReporter,
    traceurReporter: function() {
      return traceurErrorReporter(sourceTracking);
    },
    adjustSourceMaps: function() {
      return adjustSourceMaps(sourceTracking);
    },
    injectAppJS: injectAppJS
  };
};

function transpileES6(outputPath) {
  return through.obj(function(file, encoding, done) {
    var stream   = this;
    var cwd      = slash(file.cwd);
    var relative = slash(file.relative);
    var base     = slash(path.resolve(outputPath));
    var filename = slash(path.basename(file.path));
    var outFile  = base + '/' + filename;
    var outPath  = base + '/' + relative.replace(filename, '');
    var command  = [ 'traceur', '--source-maps', '--out', outFile, file.path ].join(' ');
    child.exec(command, { cwd: cwd }, function(error, stdout, stdin) {
      if (error) {
        var pending = new gutil.File();
        pending.cwd          = cwd;
        pending.base         = outputPath;
        pending.path         = outFile;
        pending.traceurError = error.toString();
        stream.push(pending);
        done();
      } else {
        gulp.src(outFile.replace(/\.js$/, '.*'))
          .pipe(gulp.dest(outPath))
          .pipe(slash())
          .pipe(semiflat(base))
          .on('data', function(file) {
            stream.push(file);
          }).on('end', function() {
            done();
          });
      }
    });
  });
}

function trackSources() {
  var before = [ ];
  var after  = [ ];
  return {
    before: function() {
      return through.obj(function(file, encode, done){
        before.push(file.path);
        this.push(file);
        done();
      });
    },
    after: function() {
      return through.obj(function(file, encode, done){
        after.push(file.path);
        this.push(file);
        done();
      });
    },
    replace: function(text) {
      for (var i = Math.min(before.length, after.length) - 1; i >= 0; i--) {
        var regexp = minimatch.makeRe(after[i], 'g');
        text = text.replace(regexp, before[i]);
      }
      return text;
    }
  }
}

function jsHintReporter() {
  var output = [ ];
  var item   = '';
  var prevfile;
  return through.obj(function(file, encoding, done) {
    if (file.jshint && !file.jshint.success && !file.jshint.ignored) {
      (function reporter(results, data, opts) {
        results.forEach(function(result) {
          var filename = result.file;
          var error    = result.error;
          if ((prevfile) && (prevfile !== filename) && (item) && (output.indexOf(item) < 0)) {
            output.push(item);
            item = '';
          }
          item    += filename + ':' + error.line + ':' +  error.character + ': ' + error.reason + '\n';
          prevfile = filename;
        });
      })(file.jshint.results, file.jshint.data);
    }
    this.push(file);
    done();
  }, function(done) {
    if ((item) && (output.indexOf(item) < 0)) {
      output.push(item);
    }
    if (output.length) {
      process.stdout.write('\n' + output.join('\n') + '\n');
    }
    done();
  });
}

function traceurErrorReporter(sourceTracker) {
  var output = [ ];
  return through.obj(function(file, encoding, done) {
    var errorText = file.traceurError;
    if (errorText) {
      var REGEXP   = /[^].*Specified as (.*)\.\nImported by \.{0,2}(.*)\.\n/m;
      var analysis = REGEXP.exec(errorText);
      var message;
      if (analysis) {
        var specified = analysis[1];
        var filename  = analysis[2] + '.js';
        var isSource  = minimatch.makeRe(filename + '$').test(file.path);
        var absolute  = (isSource) ? file.path : path.resolve(file.base + '/' + filename)
        message = absolute + ':0:0: Import not found: ' + specified + '\n';
      } else {
        message = errorText.replace(/Error\:\s*Command failed\:\s*/g, '');
      }
      var normalised = slash(message);
      var unmapped   = sourceTracker.replace(normalised);
      if (output.indexOf(unmapped) < 0) {
        output.push(unmapped);
      }
    } else {
      this.push(file);
    }
    done();
  }, function(done) {
    if (output.length) {
      process.stdout.write('\n' + output.join('\n') + '\n');
    }
    done();
  });
}

function adjustSourceMaps(sourceTracker) {
  return through.obj(function(file, encoding, done) {
    if (path.extname(file.path) === '.map') {
      function adjust(candidate) {
        var normalised = slash(candidate);
        var unmapped = sourceTracker.replace(normalised);
        var rootRelative = '/' + path.relative(file.cwd, unmapped);
        return slash(rootRelative);
      }
      var sourceMap = JSON.parse(file.contents.toString());
      delete sourceMap.sourcesContent;
      for (var key in sourceMap) {
        if (typeof sourceMap[key] == typeof '') {
          sourceMap[key] = adjust(sourceMap[key]);
        } else if (sourceMap[key] instanceof Array) {
          sourceMap[key].forEach(function (value, i, array) {
            array[i] = adjust(value);
          })
        }
      }
      var text = JSON.stringify(sourceMap, null, '  ');
      file.contents = new Buffer(text);
    }
    this.push(file);
    done();
  });
}

function injectAppJS(htmlBase, jsBase) {
  return through.obj(function(file, encoding, done) {
    var stream    = this;
    var jsFile    = slash(file.path).replace(htmlBase, jsBase).replace(/\.html?$/, '.js');
    var jsSources = gulp.src(jsFile, { read: false }).pipe(slash());
    throughPipes(function(readable) {
      return readable
        .pipe(inject(jsSources));
    })
      .output(function(file) {
        stream.push(file);
        done();
      })
      .input(file)
      .end();
  })
}