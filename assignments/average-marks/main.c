/* Assignment: first line n, second line n integer marks. Print the average with 2 decimals. */
#include <stdio.h>
int main(void) {
    int n, sum = 0, x;
    scanf("%d", &n);
    for (int i = 0; i < n; i++) { scanf("%d", &x); sum += x; }
    float avg = sum / n;
    printf("%.2f\n", avg);
    return 0;
}
