var child = require('child_process');
var path = require('path');

var through = require('through2');
var throughPipes = require('through-pipes');
var minimatch = require('minimatch');
var gulp = require('gulp');
var gutil = require('gulp-util');
var inject = require('gulp-inject');
var slash = require('gulp-slash');
var semiflat = require('gulp-semiflat');

function trackSources() {
  'use strict';
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
  };
}

module.exports = function(temp) {
  'use strict';
  var sourceTracking = trackSources();
  var outputPath     = temp;
  return {

    /**
     * Copy library files from in the input stream to the temporary directory in preparation for <code>transpile</code>.
     * Outputs a stream of the same files, now found in the temp directory.
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
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

    /**
     * Call <code>traceur</code> from the system shell to compile the source files int the stream.
     * Uses libraries that were copied to the temp directory by the <code>sources</code> operation.
     * Outputs a stream of compiled files, in relative locations in the temp directory.
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    transpile: function() {
      return through.obj(function(file, encoding, done) {
        var stream = this;

        // get parameters platform non-specific
        var cwd      = slash(file.cwd);
        var relative = slash(file.relative);
        var base     = slash(path.resolve(outputPath));
        var filename = slash(path.basename(file.path));
        var outFile  = base + '/' + filename;
        var outPath  = base + '/' + relative.replace(filename, '');

        // call traceur from the shell
        //  at the time of writing there is no stable API for single file output
        var command  = [ 'traceur', '--source-maps', '--out', outFile, file.path ].join(' ');
        child.exec(command, { cwd: cwd }, function(error) {

          // traceur error implies empty file with error property
          if (error) {
            var pending = new gutil.File();
            pending.cwd          = cwd;
            pending.base         = outputPath;
            pending.path         = outFile;
            pending.traceurError = error.toString();
            stream.push(pending);
            done();

            // output JS and MAP files to the stream
            //  ensure that their paths are platform non-specific and relative to the outputPath
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
    },

    /**
     * A terse reporter for JSHint that uses the format as <code>traceurReporter</code>.
     * Outputs elements from the input stream without transformation.
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    jsHintReporter: function() {
      var output = [ ];
      var item   = '';
      var prevfile;

      // push each item to an output buffer
      return through.obj(function(file, encoding, done) {
        if (file.jshint && !file.jshint.success && !file.jshint.ignored) {
          (function reporter(results) {
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

        // all elements to the output
        this.push(file);
        done();

        // display the output buffer with padding before and after and between each item
      }, function(done) {
        if ((item) && (output.indexOf(item) < 0)) {
          output.push(item);
        }
        if (output.length) {
          process.stdout.write('\n' + output.join('\n') + '\n');
        }
        done();
      });
    },

    /**
     * A reporter for the <code>transpile</code> step.
     * Strips from the stream files that failed compilation and displays their error message.
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    traceurReporter: function() {
      var output = [ ];

      // push each item to an output buffer
      return through.obj(function (file, encoding, done) {

        // unsuccessful element have a traceurError property
        var errorText = file.traceurError;
        if (errorText) {
          var REGEXP = /[^].*Specified as (.*)\.\nImported by \.{0,2}(.*)\.\n/m;
          var analysis = REGEXP.exec(errorText);
          var message;
          if (analysis) {
            var specified = analysis[1];
            var filename = analysis[2] + '.js';
            var isSource = minimatch.makeRe(filename + '$').test(file.path);
            var absolute = (isSource) ? file.path : path.resolve(file.base + '/' + filename);
            message = absolute + ':0:0: Import not found: ' + specified + '\n';
          } else {
            message = errorText.replace(/Error\:\s*Command failed\:\s*/g, '');
          }
          var normalised = slash(message);
          var unmapped = sourceTracking.replace(normalised);
          if (output.indexOf(unmapped) < 0) {
            output.push(unmapped);
          }

          // only successful elements to the output
        } else {
          this.push(file);
        }
        done();

        // display the output buffer with padding before and after and between each item
      }, function (done) {
        if (output.length) {
          process.stdout.write('\n' + output.join('\n') + '\n');
        }
        done();
      });
    },

    /**
     * Correct the sources in <code>.map</code> source map files to point to their original sources (rather than
     * those in the temp directory that was used during compilation).
     * Outputs a stream of input files with possibly amended contents.
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    adjustSourceMaps: function() {
      return through.obj(function(file, encoding, done) {

        // adjust a single value
        function adjust(candidate) {
          var normalised = slash(candidate);
          var unmapped = sourceTracking.replace(normalised);
          var rootRelative = '/' + path.relative(file.cwd, unmapped);
          return slash(rootRelative);
        }

        // adjust map for arrays
        function mapAdjust(value, i, array) {
          array[i] = adjust(value);
        }

        // where the file is a MAP file
        if (path.extname(file.path) === '.map') {
          var sourceMap = JSON.parse(file.contents.toString());
          delete sourceMap.sourcesContent;
          for (var key in sourceMap) {
            if (typeof sourceMap[key] === typeof '') {
              sourceMap[key] = adjust(sourceMap[key]);
            } else if (sourceMap[key] instanceof Array) {
              sourceMap[key].forEach(mapAdjust);
            }
          }
          var text = JSON.stringify(sourceMap, null, '  ');
          file.contents = new Buffer(text);
        }

        // all elements to the output
        this.push(file);
        done();
      });
    },

    /**
     * Inject a single application JS file for each HTML file in the stream.
     * Outputs a stream of files with amended contents.
     * @param {string} jsBasePath An absolute or root relative base path for the javascript file
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    injectAppJS: function(jsBasePath) {
      return through.obj(function(file, encoding, done) {
        var stream = this;

        // infer the html base path from the file.base and use this as a base to locate
        //  the corresponding javascript file
        var htmlPath  = slash(file.path);
        var htmlBase  = slash(file.base);
        var jsBase    = slash(path.resolve(jsBasePath));
        var jsFile    = htmlPath.replace(htmlBase, jsBase).replace(/\.html?$/, '.js');
        var jsSources = gulp.src(jsFile, { read: false })
          .pipe(semiflat(jsBase))
          .pipe(slash())

        // pass the html file into a stream that injects the given javascript source
        //  then add the resulting file to the output stream
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
      });
    }
  };
};
