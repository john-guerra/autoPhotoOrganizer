/* global require:true */
(function () {
    "use strict";

    var ExifImage = require('exif').ExifImage;
    // var d3 = require('d3');
    var glob = require("glob");
    var fs = require('fs');
    var EXIF = require('exif-js');


    var fmt = d3.time.format("%Y:%m:%d %H:%M:%S");
    var path = process.argv.length > 2 ? process.argv[2] : "/Users/aguerra/Pictures/fotos/2015/2015_12Dic_27_La_Pastora_selected_peq/";
    var photosByDate = [];
    var avgSeparation = 0; //What's the average separation between photos

    path = "/Volumes/EOS_DIGITAL/DCIM/101CANON/";

    var timeline = photoTimelineChart()
        .x(function (d) { return d.createDate;});



    function getExif3(result, done) {
        return function(file) {
            // console.log("get exif3" + file);
            var filePart;

            if (file.slice) {
                filePart = file.slice(0, 131072);
            } else if (file.webkitSlice) {
                filePart = file.webkitSlice(0, 131072);
            } else if (file.mozSlice) {
                filePart = file.mozSlice(0, 131072);
            } else {
                filePart = file;
            }

            var binaryReader = new FileReader();

            binaryReader.onload = function (e) {
                try {
                    EXIF.getData(binaryReader.result, function() {
                            // console.log(EXIF.pretty(this));
                            try {
                                var date =  fmt.parse(this.exifdata.DateTime);
                                // console.log(date);
                                result.push({id:file.path, file:file.path, createDate:fmt.parse(this.exifdata.DateTime)});
                            } catch (error) {
                                console.log("Error parsing image");
                                console.log(error);
                                console.log(this.exifdata);
                            }
                            done();

                        });
                       // var fileDate = EXIF.getTag(e.target.result, "CreateDate");
                } catch (error) {
                    console.log("error getting exif");
                    console.log(error);
                    done();
                }
            };
            // binaryReader.onload




            //Reading from modified date
            // result.push({file:file.path, createDate:file.lastModifiedDate});
            // done();


            // binaryReader.readAsBinaryString(filePart);
            binaryReader.readAsArrayBuffer(filePart);

        };

    }

    function getExif2(files, done) {
        return function (url) {
            console.log("get exif2" + url);
            try {
                var img = new Image();
                img.src = url;
                img.onload =  function (error, exifData) {
                    // console.log(exifData.exif.CreateDate);
                    // var d = fmt.parse(exifData.exif.CreateDate);
                    // exifData.exif.CreateDate = fmt.parse(exifData.exif.CreateDate);
                    console.log(EXIF.getTag(img, "CreatedDate"));
                    files.push({id:url, file:url, createDate:fmt.parse(EXIF.getTag(img, "CreatedDate"))});
                    done();
                    // console.log(d);
                };

                // console.log(e);
                // delete e;
            } catch (error) {
                console.log('Error: ' + error.message);
                done();
            }
        };

    }

    function getExif(files, done) {
        return function (url) {
            try {
                var e = new ExifImage({ image : url }, function (error, exifData) {
                    if (error) {
                        console.log('Error: ' + error.message);
                        done();
                        return;
                    }
                    // console.log(exifData.exif.CreateDate);
                    // var d = fmt.parse(exifData.exif.CreateDate);
                    // exifData.exif.CreateDate = fmt.parse(exifData.exif.CreateDate);

                    files.push({id: url, file:url, createDate:fmt.parse(exifData.exif.CreateDate)});
                    done();
                    // console.log(d);
                });

                // console.log(e);
                // delete e;
            } catch (error) {
                console.log('Error: ' + error.message);
                done();
            }
        };

    }

    function processFileQueue(queue, result) {
        function processFiles(files, filesresult, callback) {
            if (!files) return;

            var i =0;
            console.log("Process Files length=" + files.length );
            files.forEach(getExif3(filesresult, function () {
                i+=1;
                // console.log("Finished file i");
                if (i >= files.length) {
                    //When finished processing all the files
                    // res.send(JSON.stringify(filesresult));
                    callback(filesresult);
                }
            }));

        }

        console.log("Process files queue " +  queue.length);
        processFiles(queue.shift(), result, function (newresult) {
            //When finished processing call a batch it again
            update(newresult);
            processFileQueue(queue, newresult);
        });

    }


    function update(_photos) {
        photosByDate = _photos.sort(function (a, b) {
            return d3.ascending(a.createDate, b.createDate);
        });
        var data = {
            photos:_photos,
            albums:[]
        };

        d3.select("#fileCount").text(data.photos.length);
        var temp = d3.select("#chart")
            .datum(data);
        temp
            .call(timeline);
    }



    //Reorders the list of photos to cover the time range faster
    function reorderPhotos(photos) {
        var reordered = [];
        var n = photos.length;
        if (n < 3) {
            return photos;
        } else {
            var pivot = Math.floor(n/2);
            var left =  reorderPhotos(photos.slice(1,pivot));
            var right = reorderPhotos(photos.slice(pivot+1, n-1));

            // Reassemble the list
            return [photos[0], photos[n-1], photos[pivot]].concat(left)
                .concat(right);
        }
    }


    function handleFileSelect(evt) {
        var files = evt.target.files; // FileList object
        var filesList = [];
        var i, f;
        // Loop through the FileList and remove the files that aren't images
        for (i = 0; f = files[i]; i++) {
            // Only process image files.
            if (!f.type.match('image.*')) {
                continue;
            }
            filesList.push(f);

        }

        filesList = filesList.filter(function (d) { return  d.type.match('image.*'); });

        //Reorder the list to hopefully cover the time range faster
        filesList = reorderPhotos(filesList);

        var filesQueue = [];
        var step=50;
        for (i=0; i < filesList.length ; i+=50) {
            filesQueue.push(filesList.slice(i, i+50));
        }

        // var resultList = [];
        processFileQueue(filesQueue, photosByDate);

    } // handleFileSelect


    function detectAutoAlbums() {
        // function computeAvgSeparation(photos) {
        //     var avg = 0;
        //     var stdv = 0;
        //     for (var i=0; i < photos.length-1; i+=1) {
        //         avg += (photos[i+1].createDate - photos[i].createDate);
        //     }
        //     if (photos.length>0) avg/=(photos.length-1);
        //     return avg;
        // }



        function average(data){
          var sum = data.reduce(function(sum, value){
            return sum + value;
          }, 0);

          var avg = sum / data.length;
          return avg;
        }

        function standardDeviation(data, avg) {
            var squareDiffs = data.map(function(value){
              var diff = value - avg;
              var sqr = diff * diff;
              return sqr;
            });

            return Math.sqrt(average(squareDiffs));
        }


        var avgs = 0;
        var i;
        var stdvs = 0;
        var separations = [];
        for (i=0; i < photosByDate.length-1; i+=1) {
            separations.push(photosByDate[i+1].createDate - photosByDate[i].createDate);
        }
        var before = new Date();
        avgs = average(separations);
        stdvs = standardDeviation(separations, avgs);
        console.log("avgs computation time = " + (new Date() - before));
        var regions = [];
        var currentRegion = createRegion(0);


        //Creates a region starting in photo i
        function createRegion(i) {
            return {
                start: photosByDate[i].createDate,
                name: "Album " + (regions.length +1),
                photos: []
            };
        }

        for (i=0; i < separations.length-1; i+=1) {
            currentRegion.photos.push(photosByDate[i]);
            if (separations[i] > (avgs + stdvs*2)) {
                currentRegion.end = photosByDate[i].createDate;
                regions.push(currentRegion);
                currentRegion = createRegion(i+1);
            }
        }
        //Add the last one and close the last album
        currentRegion.photos.push(photosByDate[photosByDate.length-1]);
        currentRegion.end = photosByDate[photosByDate.length-1].createDate;
        regions.push(currentRegion);


        timeline.updateRegions(regions);

        d3.select("#avgSeparation").text(avgs+ "-" + stdvs);
    }

    document.getElementById('files').addEventListener('change', handleFileSelect, false);
    // d3.select("#files").on("change", handleFileSelect);
    d3.select("#btnAutoAlbums").on("click", detectAutoAlbums);


})();
