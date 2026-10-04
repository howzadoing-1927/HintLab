# Assignment: read one line. Print YES if it is a palindrome ignoring case and spaces, else NO.
s = input()
if s == s[::-1]:
    print("YES")
else:
    print("NO")
