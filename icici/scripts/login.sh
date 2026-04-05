#!/bin/bash

set -e

# Step 1: Request OTP
echo "Requesting OTP..."
curl -s "http://localhost:3000/requestOtp"
echo ""

# Step 2: Get OTP from user
read -rp "Enter OTP: " otp

if [ -z "$otp" ]; then
    echo "Error: OTP cannot be empty"
    exit 1
fi

# Step 3: Login with OTP
echo "Logging in..."
curl -s "http://localhost:3000/login?otp=${otp}"
echo ""
