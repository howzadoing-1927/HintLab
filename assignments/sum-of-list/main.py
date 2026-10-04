# Assignment: read space-separated integers on one line, print their sum.
nums = list(map(int, input().split()))
total = 0
for i in range(1, len(nums)):
    total += nums[i]
print(total)
