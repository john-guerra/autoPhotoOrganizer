var ExifImage = require('exif').ExifImage;
var d3 = require('d3');
var glob = require("glob");
var fs = require('fs');
var express = require("express"),
    app = express(),
    imageDir = __dirname + "/pictures/",
    imageSuffix = "-image.png",
    fs = require("fs");




var fmt = d3.time.format("%Y:%m:%d %H:%M:%S");
var url = "/Users/aguerra/Pictures/fotos/2015/2015_08Aug_01_Butterfly_Garden_Lukas_selected_peq/IMG_5472.jpg";
var path = process.argv.length > 2 ? process.argv[2] :   "/Users/aguerra/Pictures/fotos/2015/2015_08Aug_01_Butterfly_Garden_Lukas_selected_peq/";

function getExif(list, done) {
	return function (url) {
		try {
		    new ExifImage({ image : url }, function (error, exifData) {
		        if (error) {
		            console.log('Error: ' + error.message);
		            done();
		            return;
		        }
		        // console.log(exifData.exif.CreateDate);
		        var d = fmt.parse(exifData.exif.CreateDate);

		        list.push({file:url, exif:exifData.exif});
		        done();
		        // console.log(d);
		    });
		} catch (error) {
		    console.log('Error: ' + error.message);
		    done();
		}
	};

}


console.log("Path =" + path);
app.use(express.static('static'));
app.get("/getFiles", function (req, res) {
	glob(path + "*.JPG", {}, function (err, files) {
		console.log(files.length);
		var list = [];
		var i =0;
		files.forEach(getExif(list, function () {
			i+=1;
			if (i >= files.length) {
				res.send(JSON.stringify(list));
			}
		}));
	});
});

app.get("/", function (request, response) {
	response.sendFile(__dirname + "/static/index.html");
});

app.get("/images/:id", function (request, response) {
    var img = path + request.params.id;

    console.log("fetching image: ", img);
    response.sendFile(img);
});

var server = app.listen(8080, function () {
	var host = server.address().address;
	var port = server.address().port;

	console.log('Example app listening at http://%s:%s', host, port);
});

// getExif("/Volumes/CANON32/DCIM/104CANON/IMG_6852.JPG");