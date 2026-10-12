/** Representative provider output. Fixtures are not live-provider evidence. */
export const richExamples = {
  itinerary: `root = Stack([heading, days, schedule, photo])
heading = TextContent("Two days by the sea", "large-heavy")
$day = "Day 1"
days = Choice("day", "Explore a day", ["Day 1", "Day 2"], $day)
photo = Photo("artifact-${"a".repeat(64)}", "Published itinerary image", "Published image fixture")
schedule = TextContent($day == "Day 1" ? "Pier walk, seaside lunch and sunset views." : "Old Leigh, the heritage trail and Chalkwell.")`,
  bill: `$bill = 80
$people = 4
$tip = 10
root = Stack([heading, bill, people, tip, result])
heading = TextContent("Split a bill", "large-heavy")
bill = Input("bill", "Bill amount", $bill, "number")
people = Input("people", "People", $people, "number")
tip = Slider("tip", "Tip percentage", $tip, 0, 30, 1)
result = TextContent($people > 0 ? "Each person pays £" + @Round(($bill * (1 + $tip / 100)) / $people, 2) : "Enter at least one person.", "large-heavy")`,
  quiz: `$answer = "Choose an answer"
$revealed = false
root = Stack([heading, answer, check, feedback])
heading = TextContent("A quick geography quiz", "large-heavy")
answer = Choice("answer", "Capital of France", ["Choose an answer", "Paris", "Rome", "Berlin"], $answer)
check = Button("Check answer", Action([@Set($revealed, true)]))
feedback = TextContent($revealed ? ($answer == "Paris" ? "Correct — Paris is the capital of France." : "Try again. Look for the city on the Seine.") : "Choose an answer, then check it.")`,
  comparison: `$budget = 120
root = Stack([heading, budget, recommendation, table])
heading = TextContent("Compare weekend plans", "large-heavy")
budget = Input("budget", "Budget in pounds", $budget, "number")
recommendation = TextContent($budget >= 100 ? "The seaside stay fits your budget." : "Choose the day trip to stay within budget.")
table = Table("Options", ["Plan", "Cost", "Travel"], [["Day trip", "£40", "Train"], ["Seaside stay", "£100", "Train + hotel"]])`,
};
