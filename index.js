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
  var sessions = [ ];
  return {
    session: function() {
      var before  = [ ];
      var after   = [ ];
      var session = {
        before: function() {
          return through.obj(function(file, encode, done){
            before.push(path.resolve(file.path));  // enforce correct path format for the platform
            this.push(file);
            done();
          });
        },
        after: function() {
          return through.obj(function(file, encode, done){
            var source = minimatch.makeRe(file.path)
              .source.replace(/^\^|\$$/g, '') // match text anywhere on the line by removing line start/end
              .replace(/\\\//g, '[\\\\\\/]'); // detect any platform path format
            after.push(source);
            this.push(file);
            done();
          });
        },
        replace: function(text) {
          for (var i = Math.min(before.length, after.length) - 1; i >= 0; i--) {
          var regexp = new RegExp(after[i], 'gm');
            text = text.replace(regexp, before[i]);
          }
          return text;
        }
	    };
      sessions.push(session);
      return session;
    },
	  replace: function(text) {
      sessions.forEach(function(session) {
	      text = session.replace(text);
      });
      return text;
    }
  };
}

/**
 * Create an instance
 * @param outputPath A temp directory to perform compilation in, usually temporary
 * @param bannerWidth The width of banners comment, or zero for none
 */
module.exports = function(outputPath, bannerWidth) {
  'use strict';
  var sourceTracking = trackSources();
  return {

    /**
     * Copy library files from in the input stream to the temporary directory in preparation for <code>transpile</code>.
     * Outputs a stream of the same files, now found in the temp directory.
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    libraries: function() {
      return throughPipes(function(readable) {
        var session = sourceTracking.session();
        return readable
          .pipe(session.before())
          .pipe(gulp.dest(temp))
          .pipe(session.after());
      });
    },

    /**
     * Define source files from the input stream but do note copy to the temporary directory.
     * Useful for enforcing correct path format in error messages.
     * Outputs a stream of the same files.
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    sources: function() {
      return throughPipes(function(readable) {
	    var session = sourceTracking.session();
        return readable
          .pipe(session.before())
          .pipe(session.after());
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
        var cwd      = file.cwd;
        var relative = file.relative;
        var filename = path.basename(file.path);
        var outBase  = path.resolve(outputPath);
        var outPath  = path.resolve(outputPath + '/' + relative.replace(filename, ''));
        var outTemp  = path.resolve(outputPath + '/' + filename);

        // call traceur from the shell
        //  at the time of writing there is no stable API for single file output
        var command  = [ 'traceur', '--source-maps', '--out', outTemp, file.path ].join(' ');
        child.exec(command, { cwd: cwd }, function(error) {

          // traceur error implies empty file with error property
          if (error) {
            var pending = new gutil.File();
            pending.cwd           = cwd;
            pending.base          = outBase;
            pending.path          = outPath;
            pending.traceurSource = file;
            pending.traceurError  = error.toString();
            stream.push(pending);
            done();

            // output JS and MAP files to the stream
            //  ensure that their paths are platform non-specific and relative to the outputPath
          } else {
            gulp.src(outTemp.replace(/\.js$/, '.*'))
              .pipe(gulp.dest(outPath))
              .pipe(semiflat(outBase))
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
              var filename = sourceTracking.replace(result.file);
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
          var hr = new Array(bannerWidth + 1); // repeat 80 times
          process.stdout.write(hr.join('\u25BC') + '\n' + output.join('\n') + '\n' + hr.join('\u25B2'));
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
      // display the output buffer with padding before and after and between each item
      return through.obj(function (file, encoding, done) {

        // unsuccessful element have a the correct properties
        var isError = (file.isNull) && (file.traceurError) && (file.traceurSource);
        if (isError) {
    
          // bad import statement
          var analysis = (/[^].*Specified as (.*)\.\nImported by \.{0,2}(.*)\.\n/m).exec(file.traceurError);
          var message;
          if (analysis) {
            var specified = analysis[1];
            var filename  = analysis[2] + '.js';
            var source    = file.traceurSource;
            var isSource  = (path.resolve(source.cwd + filename) === path.resolve(source.path));
            var absolute  = (isSource) ? source.path : path.resolve(file.base + '/' + filename);
            message = absolute + ':0:0: Import not found: ' + specified + '\n';
      
          // all other errors
          } else {
            message = file.traceurError
              .replace(/^Error\:\s*Command failed\:\s*(.*)$/gm, '$1')
              .replace(/^\[Error\:\s*([^]*)\s*\]$/gm, '$1');   // for windows (n.b. [^]* is .* multiline)
          }
      
          // report unique errors in original sources
          var unmapped = sourceTracking.replace(message);
          if (output.indexOf(unmapped) < 0) {
            output.push(unmapped);
          }

        // only successful elements to the output
        } else {
          this.push(file);
        }
        done();

      }, function (done) {
        if (output.length) {
          var hr = new Array(bannerWidth + 1); // repeat 80 times
          process.stdout.write(hr.join('\u25BC') + '\n' + output.join('\n') + '\n' + hr.join('\u25B2'));
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
          var unmapped     = sourceTracking.replace(candidate);
          var rootRelative = '/' + slash(path.relative(file.cwd, unmapped));
          return rootRelative;
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
     * Inject all JS and CSS files found in the same relative directory as the HTML file in the stream.
     * Where a <code>jsBasePath</code> is not given JS is presumed to be adjacent to HTML.
     * Where a <code>cssBasePath</code> is not given CSS is presumed to be adjacent to HTML.
     * Outputs a stream of HTML files with amended content.
     * @param {string} [jsBasePath] An absolute or root relative base path for javascript files
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    injectAppJSCSS: function(jsBasePath, cssBasePath) {
      return through.obj(function(file, encoding, done) {
        var stream = this;

        // infer the html base path from the file.base and use this as a base to locate
        //  the corresponding javascript file
        var htmlName  = path.basename(file.path);
        var htmlPath  = path.resolve(file.path.replace(htmlName, ''));
        var htmlBase  = path.resolve(file.base);
        var jsBase    = (jsBasePath ) ? path.resolve(jsBasePath)  : htmlBase;
        var cssBase   = (cssBasePath) ? path.resolve(cssBasePath) : htmlBase;
        var glob      = [
            htmlPath.replace(htmlBase, jsBase)  + '/*.js',
            htmlPath.replace(htmlBase, cssBase) + '/*.css'
        ];
        var sources = gulp.src(glob, { read: false })
          .pipe(semiflat(jsBase))
          .pipe(slash());

        // pass the html file into a stream that injects the given sources
        //  then add the resulting file to the output stream
        throughPipes(function(readable) {
          return readable
            .pipe(inject(sources));
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
