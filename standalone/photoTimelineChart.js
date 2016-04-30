function photoTimelineChart() {
  "use strict";
  var margin = {top: 20, right: 50, bottom: 20, left: 50},
      width = 760,
      height = 80,
      xValue = function(d) { return d[0]; },
      xScale = d3.time.scale(),
      regionColor = d3.scale.category20(),
      selection = null,
      svg = null,
      xAxis = d3.svg.axis().scale(xScale).orient("bottom").tickSize(6, 0);

  function chart(_selection) {
    selection = _selection;
    selection.each(update);
  }

  function update(data) {
    // Update the x-scale.
    xScale
        .domain(d3.extent(data.photos, function (d) { return xValue(d); }))
        .range([0, width - margin.left - margin.right]);

    // Select the svg element, if it exists.
    svg = d3.select(this).selectAll("svg").data([data]);

    // Otherwise, create the skeletal chart.
    var gEnter = svg.enter().append("svg").append("g");
    gEnter.append("g").attr("id", "regions");
    gEnter.append("g").attr("id", "points");

    gEnter.append("g").attr("class", "x axis");

    // Update the outer dimensions.
    svg .attr("width", width)
        .attr("height", height);

    // Update the inner dimensions.
    var g = svg.select("g")
        .attr("transform", "translate(" + margin.left + "," + margin.top + ")");

    updatePoints(data.photos);
    updateRegions(data.albums);


    // Update the x-axis.
    g.select(".x.axis")
        .transition()
        .duration(500)
        .attr("transform", "translate(0," + (height - margin.bottom - 20)  + ")")
        .call(xAxis);
  }



  function updatePoints(photosData) {
    // if (!svg) return;


    // Update the data points.
    var points = svg.select("#points")
      .selectAll(".point")
      .data(photosData, function (d) { return d.id; });

    points.enter()
      .append("circle")
      .attr("class", "point");

    points
      .transition()
      .duration(500)
      .attr("r", 2)
      .attr("cx", X)
      .attr("cy", 10);

    points
      .exit()
      .remove();
  }

  function updateRegions(regionsData) {
    // if (!svg) return;

    // Update the regions
    var regions = svg.select("#regions")
      .selectAll(".region")
      .data(regionsData);

    regions.enter()
      .append("rect")
      .attr("class", "region");

    regions
      .attr("x", function (d) { return xScale(d.start); })
      .attr("y", 0)
      .attr("width", function (d) { return xScale(d.end) - xScale(d.start); })
      .attr("height", height - margin.bottom - 20 )
      .attr("fill", function (d) { return regionColor(d.name); })
      .attr("stroke", function (d) { return regionColor(d.name); })
      .attr("fill-opacity", 0.2);

    regions
      .exit()
      .remove();
  }

  // The x-accessor for the path generator; xScale ∘ xValue.
  function X(d) {
    return xScale(xValue(d));
  }

  chart.updateRegions = updateRegions;

  chart.margin = function(_) {
    if (!arguments.length) return margin;
    margin = _;
    return chart;
  };

  chart.width = function(_) {
    if (!arguments.length) return width;
    width = _;
    return chart;
  };

  chart.height = function(_) {
    if (!arguments.length) return height;
    height = _;
    return chart;
  };

  chart.x = function(_) {
    if (!arguments.length) return xValue;
    xValue = _;
    return chart;
  };

  return chart;
}

