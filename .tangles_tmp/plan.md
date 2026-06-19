# ADO Plan 25091 / Suite 144486

_3 test case(s) from cobwebsdev/Tangles - V7_

## Scenario 1: search person by email domain  _(work item 144635)_

**Steps:**
1. open the person search popup and click on the "additional options" arrow in the bottom of the popup
   - _Expected:_ you will see the "additional options" section with the options- ID, Vehicle, Network
2. click on the "network" drop down
   - _Expected:_ you will see the drop down list with the options - IP, Email domain, password, hashed password, device ID
3. click on email domain and fill "gmail.com" in the field and submit the search
   - _Expected:_ validate that you get persons results from dehashed with gmail email addresses

## Scenario 2: multiparams person search of name and email domain  _(work item 144636)_

**Steps:**
1. make a person search of the name "david" and the email domain "gmail.com"
   - _Expected:_ validate that all the results have a gmail email address- in the results search bar write "gmail.com" and verify that all the persons contains this keyword

## Scenario 3: search person by hashed password  _(work item 144679)_

**Steps:**
1. open the person search popup, click on the "Additional options" in the network drop down list choose  "hashed password" and fill - afdd0b4ad2ec172c586e2150770fbf9e, and submit the search
   - _Expected:_ check that you results of persons from dehashed that have the password Aa123456
2. make another search this time use the hashed password - 5c05d25b14799ac1cfbc8a5f45109855e9fd5dd50ff910144f480371978413cb9da91446e524be1aab3a7bcdcc5a76552945596f7a065fdfb9be4610a062a9e0
   - _Expected:_ validate that you got the same results
