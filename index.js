var childProcess   = require('child_process');
var path           = require('path');
var through        = require('through2');
var throughPipes   = require('through-pipes');
var gulp           = require('gulp');
var gutil          = require('gulp-util');
var inject         = require('gulp-inject');
var slash          = require('gulp-slash');
var semiflat       = require('gulp-semiflat');
var trackFilenames = require('gulp-track-filenames');
var querystring    = require('querystring');

/**
 * Create an instance.
 * @param {string} outputPath A directory in which to assemble library and perform compilation, usually temporary
 * @returns {{libraries: function, sources: function, transpile: function, jsHintReporter: function,
 *  traceurReporter: function, jasmineConcat: function, karma: function, adjustSourceMaps: function,
 *  injectAppJS: function}}
 */
module.exports = function (outputPath) {
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
    libraries: function () {
      return throughPipes(function (readable) {
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
    sources: function () {
      return throughPipes(function (readable) {
        var tracking = sourceTracking.create();
        return readable
          .pipe(tracking.before())
          .pipe(tracking.after());
      });
    },

    /**
     * Call <code>traceur</code> from the system shell to compile the source files int the stream.
     * Uses libraries that were copied to the temp directory by the <code>sources</code> operation.
     * Outputs a stream of compiled files and their source-maps, alternately.
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    transpile: function () {
      var tracking = sourceTracking.create();
      return through.obj(function (file, encoding, done) {
        var stream = this;

        // get parameters platform non-specific
        var shellCwd = path.resolve(file.cwd + '/node_modules/gulp-traceur-out/node_modules/traceur');
        var filename = path.basename(file.path);
        var outCwd   = file.cwd;
        var outBase  = path.resolve(outputPath);
        var outFinal = path.resolve(outputPath + '/' + file.relative);
        var outTemp  = path.resolve(outputPath + '/' + filename);
        var outPath  = outFinal.replace(filename, '');

        // track the output file against its source for completeness
        tracking.define(file.path, outFinal);

        // call traceur from the shell
        //  at the time of writing there is no stable API for single file output
        var command  = [ 'node', 'traceur', '--source-maps', '--out', outTemp, file.path ].join(' ');
        childProcess.exec(command, { cwd: shellCwd }, function (stderr) {

          // traceur error implies empty file with error property
          if (stderr) {
            var pending = new gutil.File({
              cwd:  outCwd,
              base: outBase,
              path: outFinal
            });
            pending.traceurSource = file;
            pending.traceurError  = stderr.toString();
            stream.push(pending);
            done();

          // output JS and MAP files to the stream
          //  ensure that their paths are platform non-specific and relative to the outputPath
          //  also adjust .map to .js.map to avoid conflict with similarly named css files and their maps
          } else {
            gulp.src([ outTemp, outTemp.replace(/\.js$/, '.map') ])
              .pipe(through.obj(function (file, encoding, done) {
                var ext = path.extname(file.path);
                switch (ext) {

                  // update the //#sourceMappingURL tag
                  case '.js':
                    var prefix   = path.basename(filename, ext);
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
              .on('data', function (file) {
                stream.push(file);
              }).on('end', function () {
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
    jsHintReporter: function (bannerWidth) {
      var output = [ ];
      var item   = '';
      var prevfile;

      // push each item to an output buffer
      return through.obj(function (file, encoding, done) {
        if (file.jshint && !file.jshint.success && !file.jshint.ignored) {
          (function reporter(results) {
            results.forEach(function (result) {
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
      }, function (done) {
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
     * Concatenate specification files in preparation for unit testing.
     * Any number of <code>replacements</code> may be specified for test-suite keywords.
     * An optional `filename` may be specified or <code>test-main.js</code> is otherwise used.
     * @param {object?} replacements An object of methods keyed by the text to replace
     * @param {string?} filename An explicit name for the virtual file
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    concatJasmine: function (replacements, filename) {
      var imports      = [ ];
      var concatenated = '';

      // process parameters
      var expressions = { };
      if (typeof replacements === 'object') {
        for (var key in replacements) {
          var source = '^(\\s*describe\\s*\\(\\s*)(?:\'' + key + '\'|"' + key + '")\\s*,';
          expressions[source] = replacements[key];
        }
      }
      filename = filename || 'test-main.js';

      /**
       * Process a single file and infer the text that is to be concatenated.
       * This is important because imports must occur once only across all files. Specification files must import only
       * the default export from any files they require.
       * @param file The vinyl file to process
       * @returns {string} The content of the file that should be concatenated
       */
      function process(file) {
        var text = file.contents.toString();
        for (var source in expressions) {
          var expression = new RegExp(source, 'mg');
          var target     = expressions[source];
          if (expression.test(text)) {
            var value = (typeof target === 'function') ? target(file) : String(target);
            text = text.replace(expression, '$1\'' + value + '\',');
          }
        }
        var IMPORT_STATEMENT = /import\s+(.*)\s+from\s+['"](.*)['"];?\n?/;
        var MULTIPLE_IMPORTS = /^\{|\}$/;
        var analysis;
        do {
          analysis = IMPORT_STATEMENT.exec(text);
          if (analysis) {

            // remove the original statement
            var start = analysis.index;
            var stop  = start + analysis[0].length;
            text = text.slice(0, start) + text.slice(stop);

            // normalise the statement
            var local      = analysis[1].replace(/\s+/g, '');
            var from       = '\'' + analysis[2] + '\'';
            var normalised = [ 'import', local, 'from', from ].join(' ') + ';';

            // check that the local varaible is Name or {*} but not multitple named variables
            // add a normalised form to the imports list
            var isMultiple = MULTIPLE_IMPORTS.test(local);
            if (isMultiple) {
              throw new Error('All imported files must use a single default export only.');
            } else if (imports.indexOf(normalised) < 0) {
              imports.push(normalised);
            }
          }
        } while(analysis);
        return text;
      }

      // concatenate files as they present, then push the final file on completion
      return through.obj(function(file, encoding, done) {
        if (!file.isNull()) {
          concatenated += process(file) + '\n';
        }
        done();
      }, function(done) {
        var text     = imports.concat(concatenated).join('\n');
        var contents = new Buffer(text);
        this.push(new gutil.File({
          cwd:      process.cwd,
          base:     path.resolve(outputPath),
          path:     path.resolve(outputPath + '/' + filename),
          contents: contents
        }));
        done();
      });
    },

    /**
     * Run karma once only with the given <code>options</code> and the files from the stream appended.
     * Removes any logging from the output.
     * No output. Ends when the Karma process ends.
     * @param {object} options Karma options
     * @param {number?} bannerWidth The width of banner comment, zero or omitted for none
     * @returns {stream.Through} A through strconcateam that performs the operation of a gulp stream
     */
     karma: function (options, bannerWidth) {
      options.singleRun = true;
      options.autoWatch = false;
      if (options.configFile) {
        options.configFile = path.resolve(options.configFile);
      }
      var files = options.files = options.files || [ ];
      return through.obj(function(file, encoding, done) {
        var isValid = !(file.isNull()) && (path.extname(file.path) === '.js');
        if (isValid && files.indexOf(file.path < 0)) {
          files.push(file.path);
        }
        done();
      }, function(done) {
        if (files.length) {
          var data    = querystring.escape(JSON.stringify(options));
          var command = [ 'node', path.join(__dirname, 'lib', 'background.js'), data ].join(' ');
          childProcess.exec(command, { cwd: process.cwd() }, function (stderr, stdout) {
            var report = stdout
              .replace(/^\s+/gm, '')
//              .replace(/^LOG.*\n/gm, '')    // remove logging
              .replace(/at\s+null\..*/gm, '') // remove file reference
              .replace(/\n\n/gm, '\n')        // consolidate consecutive line breaks
              .replace(/^\n|\n$/g, '');       // remove leading and trailing line breaks
            var original = sourceTracking.replace(report) + '\n';
            var width    = Number(bannerWidth) || 0;
            var hr       = new Array(width + 1);   // this is a good trick to repeat a character N times
            var start    = (width > 0) ? (hr.join('\u25BC') + '\n') : '';
            var stop     = (width > 0) ? (hr.join('\u25B2') + '\n') : '';
            process.stdout.write(start + '\n' + original + '\n' + stop);
            done();
          });
        } else {
          done();
        }
      });
    },

    /**
     * A reporter for the <code>transpile</code> step.
     * Strips from the stream files that failed compilation and displays their error message.
     * @param {number?} bannerWidth The width of banner comment, zero or omitted for none
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    traceurReporter: function (bannerWidth) {
      var output = [ ];

      // push each item to an output buffer
      return through.obj(function (file, encoding, done) {

        // unsuccessful element have a the correct properties
        var isError = (file.isNull()) && (file.traceurError) && (file.traceurSource);
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
    adjustSourceMaps: function () {
      return through.obj(function (file, encoding, done) {

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
     * Inject all JS files found in the same relative directory as the HTML file in the stream.
     * Also inject all JS files found in the directories above, up to and including the base path.
     * Where a <code>jsBasePath</code> is not given JS is presumed to be adjacent to HTML.
     * Outputs a stream of HTML files with amended content.
     * @param {string} jsBasePath An absolute or root relative base path for javascript files
     * @returns {stream.Through} A through stream that performs the operation of a gulp stream
     */
    injectAppJS: function (jsBasePath) {
      return through.obj(function (file, encoding, done) {
        var stream = this;

        // infer the html base path from the file.base and use this as a base to locate
        //  the corresponding javascript file
        var htmlName  = path.basename(file.path);
        var htmlPath  = path.resolve(file.path.replace(htmlName, ''));
        var htmlBase  = path.resolve(file.base);
        var jsBase    = (jsBasePath) ? path.resolve(jsBasePath)  : htmlBase;
        var relative  = htmlPath.replace(htmlBase, '').split(/[\\\/]/g);
        var glob      = relative.map(function(unused, i, array) {
          return [ jsBase ].concat(array.slice(0, i + 1)).concat('*.js').join('/');
        });
        var sources = gulp.src(glob, { read: false })
          .pipe(semiflat(jsBase))
          .pipe(slash());

        // pass the html file into a stream that injects the given sources
        //  then add the resulting file to the output stream
        throughPipes(function (readable) {
          return readable
            .pipe(inject(sources));
        })
          .output(function (file) {
            stream.push(file);
            done();
          })
          .input(file)
          .end();
      });
    }
  };
};
