<!DOCTYPE html>
<meta charset="utf-8">
<body>
<script src="http://d3js.org/d3.v3.js"></script>
<script>

var width = 960,
    height = 500,
    twoPi = 2 * Math.PI;

var dataset = {
                  progress: 35,
                  total: 46
              };

var arc = d3.svg.arc()
    .innerRadius(170)
    .outerRadius(220)
    .startAngle(0);

var svg = d3.select("body").append("svg")
    .attr("width", width)
    .attr("height", height)
  .append("g")
    .attr("transform", "translate(" + width / 2 + "," + height / 2 + ")")

var meter = svg.append("g")
    .attr("class", "season-progress");

var background = meter.append("path")
    .datum({endAngle: twoPi})
    .style("fill", "#ddd")
    .attr("d", arc);

var foreground = meter.append("path")
    .datum({endAngle:0})
    .style("fill", "orange")
    .attr("class", "foreground")
    .attr("d", arc);

  foreground.transition()
    .duration(1000)
    .ease("linear")
    .attrTween("d", function(d) {
               var interpolate = d3.interpolate(d.endAngle, twoPi * dataset["progress"] / dataset["total"])
               return function(t) {
                  d.endAngle = interpolate(t);
                  return arc(d);
               }
            });

  var text =  meter.append("text")
    .attr("text-anchor", "middle")
    .attr("dy", ".35em")
    .attr("font-size", "24")
    .text(dataset["progress"]);

</script>
