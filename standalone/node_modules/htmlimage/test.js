var Image = require('./');
var test = require('tap').test;
var http = require('http');
var fs = require('fs');
var img = __dirname + '/images/Gnu_meditate_levitate.png';


test('async (fs)', function(t) {

  var i = new Image();

  i.onload = function() {
    t.ok(i.imageData);
    t.equal(i.imageData.width, 1280);
    t.equal(i.imageData.height, 1112);
    t.equal(i.imageData.width, i.width);
    t.equal(i.imageData.height, i.height);
    t.equal(i.complete, true);
    t.end();
  };

  i.src = img;

});

test('windows fs test', function(t) {

  var i = new Image();

  var caught = false
  try {
    var resolved = i.resolve(
      'C:\\Users\\tmpvar\\',
      'C:\\Users\\tmpvar\\path\\to\\test.png'
    );

    t.equal(resolved, 'file:///C:/Users/tmpvar/path/to/test.png');
  } catch(e) {
    caught = true;
  }

  t.ok(!caught);
  t.end();
});

test('async (http)', function(t) {
  var server = http.createServer(function(req, res) {
    res.writeHead(200, { 'Content-type' : 'image/png' });
    fs.createReadStream(img).pipe(res);
  });

  server.listen(16892, function() {
    var i = new Image();

    i.onload = function() {
      t.ok(i.imageData);
      t.equal(i.imageData.width, 1280);
      t.equal(i.imageData.height, 1112);

      server.close();
      t.end();
    };

    i.src = 'http://localhost:16892/whatever.png';
  });
});

