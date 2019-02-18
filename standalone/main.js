/* global  d3 */
(function () {
    "use strict";


    // var glob = require("glob");
    // var fs = require("fs");
    var fse = require("fs-extra");
    var EXIF = require("exif-js");
    var path = require("path");

    var gui = require("nw.gui");
    if (process.platform === "darwin") {
        var mb = new gui.Menu({type: "menubar"});
        mb.createMacBuiltin("RoboPaint", {hideEdit: false});
        gui.Window.get().menu = mb;
    }


    var fmt = d3.time.format("%Y:%m:%d %H:%M:%S");
    var inputPath = process.argv.length > 2 ? process.argv[2] : "/Users/aguerra/Pictures/fotos/2015/2015_12Dic_27_La_Pastora_selected_peq/";
    var photosByDate = [];
    var albums = [];
    var avgSeparation = 0; //What"s the average separation between photos
    var stDevSeparation = 0; // The standard deviation of the separation between photos
    var separation = 0; // What should we use to separate
    var separations = []; // A list of the separations between photos

    // inputPath = "/Volumes/EOS_DIGITAL/DCIM/101CANON/";

    var albumsC = albumsChart();
    var timelineC = photoTimelineChart()
        .x(function (d) { return d.createDate;});

    function getDateFromStr(str) {
        var m = str.match(/(\d{4})(?:-|\/|)(\d{2})(?:-|\/|)(\d{2}).*/);
        if (!m) return m;
        return new Date(+m[1], +m[2] - 1, +m[3]);
    }

    function getExif3(result, done) {
        return function(file) {
            console.log("get exif3", file);
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

            var date;
            // Check if the name contains a date
            date = getDateFromStr(file.name);
            if (!date) {
                // If not get the latest modified date
                date = file.lastModifiedDate;
            }
            var binaryReader = new FileReader();

            binaryReader.onload = function (e) {
                try {
                    EXIF.getData(binaryReader.result, function() {
                        try {
                            var tmpdate =  fmt.parse(this.exifdata.DateTime);
                            if (tmpdate) {
                                date = tmpdate;
                            } else {
                                console.log("Error parsing date ");
                                console.log(EXIF.pretty(this));
                            }
                            // console.log(date);
                        } catch (error) {
                            console.log("Error parsing image");
                            console.log(error);
                            console.log(this.exifdata);
                        }
                    });
                    // var fileDate = EXIF.getTag(e.target.result, "CreateDate");
                } catch (error) {
                    console.log("error getting exif");
                    console.log(error);
                    // done();
                }

                if (date === undefined || date === null) {
                    alert("Date === undefined \n" + file.path );
                }
                result.push({id:file.path,
                    url:file.path,
                    // thumb:this.exifdata["Composite:ThumbnailImage"],
                    createDate:date
                });
                done();

            };
            // binaryReader.onload

            //Reading from modified date
            // result.push({file:file.path, createDate:file.lastModifiedDate});
            // done();


            // binaryReader.readAsBinaryString(filePart);
            binaryReader.readAsArrayBuffer(filePart);

        };

    }

    // function getExif2(files, done) {
    //     return function (url) {
    //         console.log("get exif2" + url);
    //         try {
    //             var img = new Image();
    //             img.src = url;
    //             img.onload =  function (error, exifData) {
    //                 // console.log(exifData.exif.CreateDate);
    //                 // var d = fmt.parse(exifData.exif.CreateDate);
    //                 // exifData.exif.CreateDate = fmt.parse(exifData.exif.CreateDate);
    //                 console.log(EXIF.getTag(img, "CreatedDate"));
    //                 files.push({id:url, file:url, createDate:fmt.parse(EXIF.getTag(img, "CreatedDate"))});
    //                 done();
    //                 // console.log(d);
    //             };

    //             // console.log(e);
    //             // delete e;
    //         } catch (error) {
    //             console.log("Error: " + error.message);
    //             done();
    //         }
    //     };

    // }

    // function getExif(files, done) {
    //     return function (url) {
    //         try {
    //             var e = new ExifImage({ image : url }, function (error, exifData) {
    //                 if (error) {
    //                     console.log("Error: " + error.message);
    //                     done();
    //                     return;
    //                 }
    //                 // console.log(exifData.exif.CreateDate);
    //                 // var d = fmt.parse(exifData.exif.CreateDate);
    //                 // exifData.exif.CreateDate = fmt.parse(exifData.exif.CreateDate);

    //                 files.push({id: url, file:url, createDate:fmt.parse(exifData.exif.CreateDate)});
    //                 done();
    //                 // console.log(d);
    //             });

    //             // console.log(e);
    //             // delete e;
    //         } catch (error) {
    //             console.log("Error: " + error.message);
    //             done();
    //         }
    //     };

    // }

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
            detectAlbums();
        });

    }


    function update(_photos) {
        photosByDate = _photos.sort(function (a, b) {
            return d3.ascending(a.createDate, b.createDate);
        });
        var data = {
            photos:_photos,
            albums:albums
        };

        d3.select("#fileCount").text(data.photos.length);
        var temp = d3.select("#chart")
            .datum(data);
        temp
            .call(timelineC);

        updateAlbums(data.albums);

    }

    function updateAlbums(_albums) {
        if (_albums) albums = _albums;

        updateAlbumNames();

        var temp = d3.select("#albums")
            .datum(albums);
        temp
            .call(albumsC);
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
        var filesList = []; var i, f;
        // Loop through the FileList and remove the files that aren"t images
        for (i = 0; (f = files[i]); i++) {
            // Only process image files.
            if (!d3.select("#chIncludeAllFiles").property("checked") &&
                !f.type.match("image.*") && !f.type.match("video.*")) {
                continue;
            }
            filesList.push(f);
        }

        // filesList = filesList.filter(function (d) { return  d.type.match("image.*"); });

        //Reorder the list to hopefully cover the time range faster
        filesList = reorderPhotos(filesList);

        var filesQueue = [];
        var step = 50;
        for (i=0; i < filesList.length ; i+=step) {
            filesQueue.push(filesList.slice(i, i+step));
        }

        // var resultList = [];
        processFileQueue(filesQueue, photosByDate);


        if (files[0]) {
            // Set output directory to the input directory by default
            var fl = new FileList();
            fl.append(new File(
                path.dirname(files[0].path),
                ""
            ));
            document.getElementById("output").files = fl;
        }

    } // handleFileSelect

    // Converts time using the selected range
    function convertToFrom(time, toFrom) {
        var range = d3.select("#selTimeRange").property("value");
        var timeConverted=time;
        if (toFrom==="to") {
            switch(range) {
                case "seconds": timeConverted = time; break;
                case "minutes": timeConverted = time/(1000*60); break;
                case "hours": timeConverted = time/(1000*60*60); break;
                case "days": timeConverted = time/(1000*60*60*24); break;
                case "months": timeConverted = time/(1000*60*60*24*30); break;
                case "years": timeConverted = time/(1000*60*60*24*365); break;
            }
        } else {
            switch(range) {
                case "seconds": timeConverted = time; break;
                case "minutes": timeConverted = time*(1000*60); break;
                case "hours": timeConverted = time*(1000*60*60); break;
                case "days": timeConverted = time*(1000*60*60*24); break;
                case "months": timeConverted = time*(1000*60*60*24*30); break;
                case "years": timeConverted = time*(1000*60*60*24*365); break;
            }
        }
        return timeConverted;

    }
    // Receives time in seconds and displays it in the appropriate format
    function setTime(time, id) {
        var timeConverted = convertToFrom(time, "to");
        d3.select(id).property("value", timeConverted);
    }

    // Returns the current time separation
    function getTime() {
        var time = d3.select(id).property("value", timeConverted);
        var timeConverted=convertToFrom(time, "from");
        return timeConverted;
    }

    function getSeparation() {
        return d3.select("#chAutoCompute").property("checked")?
            avgSeparation+2*stDevSeparation :
            convertToFrom(+d3.select("#inSeparation").property("value"), "from");
    }
    function updateTimes() {
        separation = getSeparation();
        setTime(separation, "#inSeparation");
        setTime(avgSeparation, "#inAvgTime");
        setTime(stDevSeparation, "#inStDevTime");
    }


    function computeSeparations() {
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
        separations=[];
        for (i=0; i < photosByDate.length-1; i+=1) {
            separations.push(photosByDate[i+1].createDate - photosByDate[i].createDate);
        }
        var before = new Date();
        avgs = average(separations);
        stdvs = standardDeviation(separations, avgs);
        console.log("avgs computation time = " + (new Date() - before));


        avgSeparation=avgs;
        stDevSeparation=stdvs;
        separation = 2*stdvs;
        updateTimes();
    }

    function detectAlbums() {
        //Creates a region starting in photo i
        function createRegion(i) {
            return {
                start: photosByDate[i].createDate,
                name: "Album " + (albums.length +1),
                photos: [],
                id: albums.length
            };
        }
        albums = [];

        computeSeparations();

        var currentRegion = createRegion(0);
        for (var i=0; i < separations.length; i+=1) {
            currentRegion.photos.push(photosByDate[i]);
            if (separations[i] > getSeparation()) {
                currentRegion.end = photosByDate[i].createDate;
                setNameForAlbum(currentRegion);
                albums.push(currentRegion);
                currentRegion = createRegion(i+1);
            }
        }
        //Add the last one and close the last album
        currentRegion.photos.push(photosByDate[photosByDate.length-1]);
        currentRegion.end = photosByDate[photosByDate.length-1].createDate;
        albums.push(currentRegion);


        timelineC.updateRegions(albums);
        updateAlbums(albums);
    }
    function setNameForAlbum(album, i) {

        var dateFmt = d3.time.format(document.getElementById("inputDateFmt").value);
        var prefix = document.getElementById("inputPrefix").value;
        album.name = dateFmt(album.start) + "_" + prefix + "_" + (i+1);
        return album.name;
    }

    function updateAlbumNames() {
        console.log(albums);
        albums.forEach(setNameForAlbum);
    }

    function copyAlbums() {
        var outputFolder = document.getElementById("output").files;
        if (albums.length ===0) {
            alert("Run autoalbums first");
        }
        if (!outputFolder) {
            alert("Select an output folder first");
            return;
        }
        var copyAlbum = function (album, i) {
            if (!album || !album.photos || album.photos.length === 0) {
                alert("Requested to copy an empty album");
                return;
            }
            var photosCopiedCount = 0;
            var albumOutput = path.join(outputFolder[0].path, album.name);

            var callbackCopy = function (err) {
                if (err) {
                    alert("Error copying/moving the file " + err);
                    console.log(err);
                    return;
                }
                photosCopiedCount += 1;
                d3.select("#copyProgress")
                    .text("Album: " + albumOutput + "  copying " + photosCopiedCount + " of " + album.photos.length);
            };

            album.photos.forEach( function (photo) {
                if (document.getElementById("chMoveOrCopy").checked) {
                    fse.move(photo.url, path.join(albumOutput, path.basename(photo.url)), callbackCopy );
                } else {
                    fse.copy(photo.url, path.join(albumOutput, path.basename(photo.url)), callbackCopy );

                }
            });
        };
        albums.forEach(copyAlbum);
    }

    document.getElementById("files").addEventListener("change", handleFileSelect, false);
    // d3.select("#files").on("change", handleFileSelect);
    d3.select("#selTimeRange").on("change", detectAlbums);
    d3.select("#btnAutoAlbums").on("click", detectAlbums);
    d3.select("#inSeparation").on("change", detectAlbums);
    d3.select("#chAutoCompute").on("change", detectAlbums);
    d3.select("#btnCopy").on("click", copyAlbums);
    d3.select("#inputPrefix").on("change", updateAlbums);
    d3.select("#inputDateFmt").on("change", updateAlbums);



})();
