
var margin = {top: 20, right: 0, bottom: 0, left: 0},
    width = 960,
    height = 500 - margin.top - margin.bottom;
var fmt = d3.time.format("%Y:%m:%d %H:%M:%S");

var x = d3.time.scale()
    	.range([0, width]);

// var y = d3.scale.linear()
//     .domain([0, height])
//     .range([0, height]);

// var treemap = d3.layout.treemap()
//     .children(function(d, depth) { return depth ? null : d._children; })
//     .sort(function(a, b) { return a.value - b.value; })
//     .ratio(height / width * 0.5 * (1 + Math.sqrt(5)))
//     .round(false);

var svg = d3.select("#chart").append("svg")
    .attr("width", width + margin.left + margin.right)
    .attr("height", height + margin.bottom + margin.top)
    .style("margin-left", -margin.left + "px")
    .style("margin.right", -margin.right + "px")
  .append("g")
    .attr("transform", "translate(" + margin.left + "," + margin.top + ")")
    .style("shape-rendering", "crispEdges");

d3.json("getFiles", function (err, data) {
	data.forEach(function (d) {
		d.exif.CreateDate = fmt.parse(d.exif.CreateDate);
	});
	var imgs = svg.selectAll("rect")
		.data(data, function (d) { return d.file; })



	x.domain(d3.extent(data, function (d) { return d.exif.CreateDate; }))
	imgs.enter().append("rect");
	imgs
		.attr("x", function (d) { return x(d.exif.CreateDate); })
		.attr("y", 0)
		.attr("width", 2)
		.attr("height", 100)
		.attr("xlink:href", function (d) {
		var parts = d.file.split("/");
		return "images/" + parts[parts.length - 1];
	});
	imgs.exit().remove();
});