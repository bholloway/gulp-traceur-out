var child          = require('child_process');
var path           = require('path');
var through        = require('through2');
var throughPipes   = require('through-pipes');
var gulp           = require('gulp');
var gutil          = require('gulp-util');
var inject         = require('gulp-inject');
var slash          = require('gulp-slash');
var semiflat       = require('gulp-semiflat');
var trackFilenames = require('gulp-track-filenames');

/**
 * Create an instance.
 * @param {string} outputPath A directory in which to assemble library and perform compilation, usually temporary
 * @returns {{ libraries: function, sources: function, transpile: function, jsHintReporter: function,
 * traceurReporter: function, adjustSourceMaps: function }}
 */
module.exports = function(outputPath) {
  'use strict';
  if (typeof outputPath !== 'string') {
    throw new Error('outputPath is required but was not specified');
  }
  var sourceTracking = new trackFilenames();
  return {

    /**
     * Copy library files from in the input stream to the temporary directory in preparation for <code>transpile</code>.
     * Outputs a stream of the same files, now found in the temp directory.
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    libraries: function() {
      return throughPipes(function(readable) {
        var tracking = sourceTracking.create();
        return readable
          .pipe(tracking.before())
          .pipe(gulp.dest(outputPath))
          .pipe(tracking.after());
      });
    },

    /**
     * Define source files from the input stream but do not copy to the temporary directory.
     * Useful for enforcing correct path format in error messages.
     * Outputs a stream of the same files.
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    sources: function() {
      return throughPipes(function(readable) {
	    var tracking = sourceTracking.create();
        return readable
          .pipe(tracking.before())
          .pipe(tracking.after());
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
          //  also adjust .map to .js.map to avoid conflict with similarly named css files and their maps
          } else {
            gulp.src(outTemp.replace(/\.js$/, '.*'))
              .pipe(through.obj(function(file, encoding, done) {
                switch (path.extname(file.path)) {

                  // update the //#sourceMappingURL tag
                  case '.js':
                    var prefix   = path.basename(filename).replace(path.extname(filename), '');
                    var source   = '^\\s*(//#\\s*sourceMappingURL\\s*=\\s*' + prefix + ').map\\s*$';
                    var contents = file.contents.toString().replace(new RegExp(source, 'im'), '$1.js.map');
                    file.contents = new Buffer(contents);
                    break;

                  // change the filename
                  case '.map':
                    file.path = file.path.replace(/\.map$/, '.js.map');
                    break;
                }
                this.push(file);
                done();
              }))
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
     * @param {number?} bannerWidth The width of banner comment, zero or omitted for none
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    jsHintReporter: function(bannerWidth) {
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
          var width = Number(bannerWidth) || 0;
          var hr    = new Array(width + 1);   // this is a good trick to repeat a character N times
          var start = (width > 0) ? (hr.join('\u25BC') + '\n') : '';
          var stop  = (width > 0) ? (hr.join('\u25B2') + '\n') : '';
          process.stdout.write(start + '\n' + output.join('\n') + '\n' + stop);
        }
        done();
      });
    },

    /**
     * A reporter for the <code>transpile</code> step.
     * Strips from the stream files that failed compilation and displays their error message.
     * @param {number?} bannerWidth The width of banner comment, zero or omitted for none
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    traceurReporter: function(bannerWidth) {
      var output = [ ];

      // push each item to an output buffer
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
          var original = sourceTracking.replace(message);
          if (output.indexOf(original) < 0) {
            output.push(original);
          }

        // only successful elements to the output
        } else {
          this.push(file);
        }
        done();

      // display the output buffer with padding before and after and between each item
      }, function (done) {
        if (output.length) {
          var width = Number(bannerWidth) || 0;
          var hr    = new Array(width + 1);   // this is a good trick to repeat a character N times
          var start = (width > 0) ? (hr.join('\u25BC') + '\n') : '';
          var stop  = (width > 0) ? (hr.join('\u25B2') + '\n') : '';
          process.stdout.write(start + '\n' + output.join('\n') + '\n' + stop);
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
          var original     = sourceTracking.replace(candidate);
          var rootRelative = '/' + slash(path.relative(file.cwd, original));
          return rootRelative;
        }

        // adjust map for arrays
        function mapAdjust(value, i, array) {
          array[i] = adjust(value);
        }

        // where the file is a MAP file
        if (path.extname(file.path) === '.map') {
          var sourceMap = JSON.parse(file.contents.toString());
          delete sourceMap.file;
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
     * @param {string} jsBasePath An absolute or root relative base path for javascript files
     * @param {string} cssBasePath An absolute or root relative base path for css files
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
