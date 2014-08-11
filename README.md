# gulp-traceur-out

> Compile a single file (per traceur --out) such that for each top level JS file all es6 imports are resolved inline.

## Install

Install with [npm](https://npmjs.org/package/gulp-traceur-out).

```
npm install --save-dev gulp-traceur-out
```

## Usage

Please refer to the [proof of concept](https://github.com/bholloway/es6-modular).

## Comparisons

This plugin is influenced by [Guy Bedford's article](http://guybedford.com/practical-workflows-for-es6-modules).

It arguably duplicates the functionality of [Browserify](http://browserify.org/). Please consider which implementation
best suits your needs.

## Reference

### `(outputPath)`

Create an instance.

@param `{string} outputPath` A directory in which to assemble library and perform compilation, usually temporary.

@returns `{{libraries: function, sources: function, transpile: function, jsHintReporter: function,
  traceurReporter: function, concatJasmine: function, karma: function, adjustSourceMaps: function,
  injectAppJS: function}}`
 
### `.libraries()`

Copy library files from in the input stream to the temporary directory in preparation for `transpile`.

Outputs a stream of the same files, now found in the temp directory.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream

### `.sources()`

Define source files from the input stream but do not copy to the temporary directory.

Useful for enforcing correct path format in error messages.

Outputs a stream of the same files.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.

### `.transpile()`

Call `traceur` from the system shell to compile the source files int the stream.

Uses libraries that were copied to the temp directory by the `sources` operation.

Outputs a stream of compiled files and their source-maps, alternately.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.

### `.jsHintReporter([bannerWidth])`

A terse reporter for JSHint that uses the format as `traceurReporter`.

Outputs elements from the input stream without transformation.

@param `{number?} bannerWidth` The width of banner comment, zero or omitted for none.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.

### `.traceurReporter([bannerWidth])`

A reporter for the `transpile` step.

Strips from the stream files that failed compilation and displays their error message.

@param `{number?} bannerWidth` The width of banner comment, zero or omitted for none.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.

### `.concatJasmine([replacements], [filename])`

Concatenate specification files in preparation for compilation and unit testing.

This is important because imports must occur once only across all files. Specification files must import only the
default export from any files they require.

Any number of `replacements` may be specified for the first string argument of test-suite methods such as `describe`,
`module`.

An optional `filename` may be specified or `test-main.js` is otherwise used.

@param `{object?} replacements` An object of methods keyed by the text to replace

@param `{string?} filename` An explicit name for the virtual file

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream

### `.karma(options, [bannerWidth])`

Run karma once only with the given `options` and the files from the stream appended.

No output. Ends when the Karma process ends.

@param `{object} options` Karma options.
@param `{number?} bannerWidth` The width of banner comment, zero or omitted for none.
@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.

### `.adjustSourceMaps()`

Correct the sources in `.map` source map files to point to their original sources (rather than those in the temp
directory that was used during compilation).

Outputs a stream of input files with possibly amended contents.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.

### `.injectAppJS([jsBasePath])`

Inject all JS files found in the same relative directory as the HTML file in the stream.

Also inject all JS files found in the directories above, up to and including the base path.

Where a `jsBasePath` is not given JS is presumed to be adjacent to HTML.

Outputs a stream of HTML files with amended content.

@param `{string?} jsBasePath` An absolute or root relative base path for javascript files.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.
    