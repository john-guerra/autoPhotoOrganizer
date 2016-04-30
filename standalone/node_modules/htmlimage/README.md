# HTMLImageElement

A standalone image element doing HTMLImageElement related things, on node.js

## install

`npm install htmlimage`

## use

__NOTE__: this library currently only works with `png` files

```javascript

var Image = require('htmlimage').HTMLImageElement;

var i = new Image();

i.onload = function() {

  // do something with image.imageData.data (which is a pixel buffer)

};

i.onerror = function(err) {
  // OHNOEZ!
}

i.src = "http://domain.tld/path/to/file.png";

```

# license

MIT