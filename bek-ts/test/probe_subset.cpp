// F3 probe: prints the first 200 values of subset_indices (sh_vq.cpp:40-50)
// for num_points = 20000 (data/tiny.ply splat count), to cross-check the TS
// MT19937 + uniform_int_distribution port. Also prints raw mt19937(5489) at
// index 10000 as a sanity check on the engine itself (expected: 4123659995).
#include <random>
#include <numeric>
#include <vector>
#include <cstdio>

int main() {
    // Standard MT19937 test vector: 10000th output with seed 5489.
    {
        std::mt19937 rng(5489);
        unsigned v = 0;
        for (int i = 0; i < 10000; ++i) v = rng();
        printf("mt19937_seed5489_10000th=%u (expected 4123659995)\n", v);
    }

    const int num_points = 20000;
    std::vector<int> subset_indices(num_points);
    std::iota(subset_indices.begin(), subset_indices.end(), 0);
    std::mt19937 rng(0);
    int sample_cap = 35000;
    int sample_size = std::min(sample_cap, std::max(5000, static_cast<int>(num_points * 0.10)));
    sample_size = std::min(sample_size, num_points);
    for (int i = 0; i < sample_size; ++i) {
        std::uniform_int_distribution<int> dist(i, num_points - 1);
        int j = dist(rng);
        std::swap(subset_indices[i], subset_indices[j]);
    }
    printf("sample_size=%d\n", sample_size);
    for (int i = 0; i < 200; ++i) {
        printf("%d%s", subset_indices[i], i + 1 < 200 ? "," : "\n");
    }
    return 0;
}
