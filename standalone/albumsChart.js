
function albumsChart() {
  "use strict";
  // var xScale = d3.scale.linear();

  function chart(selection) {
    selection.each(function(data) {

      // // Update the x-scale.
      // xScale
      //     .domain([0, d3.max(data, function(d) { return d.numPhotos; })])
      //     .range([0, width - margin.left - margin.right]);

      // Select the svg element, if it exists.
      var div = d3.select(this).selectAll(".albumsChart").data([data]);

      // Otherwise, create the skeletal chart.
      var gEnter = div.enter().append("div")
        .attr("class", "albumsChart");

      var albums = div.selectAll(".album")
        .data(data, function (d) {
          return d.id;
        });

      var albumEnter = albums.enter()
        .append("div")
        .attr("class", "album");
      albumEnter.append("div")
        .attr("class", "albumTitle");
      albumEnter.append("div")
        .attr("class", "albumPhotos");

      albums.exit().remove();


      albums.select(".albumTitle")
        .text(function (d) { return d.name; });




      var photos = albums.select(".albumPhotos")
        .selectAll(".albumPhoto")
        .data(function (d) { return d.photos; });

      photos.enter()
        .append("img");

      photos
        .attr("class", function (d, i) {
          var ret= "albumPhoto";
          // Show only the photo if it is the first or the last one
          ret += i === 0 || i === (photos.data().length - 1) ?
            " showPhoto" :
            " noShowPhoto";
          return ret;
        })
        .attr("src", function (d, i) {

          return i === 0 || i === (photos.data().length - 1) ? d.url : "";
        });

      photos
        .exit()
        .remove();
    });
  }


  return chart;
}

