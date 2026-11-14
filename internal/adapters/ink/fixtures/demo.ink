VAR route = "undecided"
VAR roll = 0

-> start

=== start
A sign points toward two doors. # scene:crossroads
+ [Take the left path # direction:left]
    ~ route = "left"
    ~ roll = RANDOM(1, 6)
    -> left_path
+ [Take the right path # direction:right]
    ~ route = "right"
    ~ roll = RANDOM(1, 6)
    -> right_path

=== left_path
The left path glows. A die shows {roll}. # route:left
{route == "left":
    You followed the left sign. # route_check:left
}
-> decision

=== right_path
The right path echoes. A die shows {roll}. # route:right
{route == "right":
    You followed the right sign. # route_check:right
}
-> decision

=== decision
Choose what to do next. # scene:decision
+ [Return by the same path # action:return]
    {route == "left":
        -> left_ending
    }
    -> right_ending
+ [Climb the tower # action:tower]
    -> tower_ending

=== left_ending
The left road leads home. # ending:left
-> END

=== right_ending
The right road reaches the river. # ending:right
-> END

=== tower_ending
The tower door closes. # ending:tower
-> END
