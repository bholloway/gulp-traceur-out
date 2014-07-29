# gulp-traceur-out

> Compile a single file (per traceur --out) such that for each top level JS file all es6 imports are resolved inline.

## Install

Install with [npm](https://npmjs.org/package/gulp-traceur-out).

```
npm install --save-dev gulp-traceur-out
```

## Usage

Please refer to the [proof of concept](https://github.com/bholloway/es6-modular).

## Reference

### `(outputPath)`

Create an instance.

@param `{string} outputPath` A directory in which to assemble library and perform compilation, usually temporary.

@returns `{{ libraries: function, sources: function, transpile: function, jsHintReporter: function,
 traceurReporter: function, adjustSourceMaps: function }}`
 
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

Outputs a stream of compiled files, in relative locations in the temp directory.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.

### `.jsHintReporter([bannerWidth])`

A terse reporter for JSHint that uses the format as <code>traceurReporter</code>.

Outputs elements from the input stream without transformation.

@param `{number?} bannerWidth` The width of banner comment, zero or omitted for none.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.

### `.traceurReporter([bannerWidth])`

A terse reporter for JSHint that uses the format as `traceurReporter`.

Outputs elements from the input stream without transformation.

@param `{number?} bannerWidth` The width of banner comment, zero or omitted for none.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.

### `.adjustSourceMaps()`

Correct the sources in `.map` source map files to point to their original sources (rather than those in the temp
directory that was used during compilation).

Outputs a stream of input files with possibly amended contents.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.

### `.injectAppJSCSS([jsBasePath], [cssBasePath])`

Inject all JS and CSS files found in the same relative directory as the HTML file in the stream.

Where a `jsBasePath` is not given JS is presumed to be adjacent to HTML.

Where a `cssBasePath` is not given CSS is presumed to be adjacent to HTML.

Outputs a stream of HTML files with amended content.

@param `{string?} jsBasePath` An absolute or root relative base path for javascript files.

@param `{string?} cssBasePath` An absolute or root relative base path for css files.

@returns `{stream.Through}` A through stream that performs the operation of a gulp stream.
    