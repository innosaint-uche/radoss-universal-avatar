#import <Foundation/Foundation.h>
#import <Security/Security.h>

static void emit(NSDictionary *payload) {
    NSError *error = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
    if (!data) {
        fprintf(stderr, "keychain helper response encoding failed\n");
        exit(2);
    }
    fwrite(data.bytes, 1, data.length, stdout);
    fputc('\n', stdout);
}

static NSDictionary *baseQuery(NSString *service, NSString *account) {
    return @{
        (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService: service,
        (__bridge id)kSecAttrAccount: account
    };
}

static int failStatus(OSStatus status) {
    emit(@{ @"ok": @NO, @"status": @(status) });
    return 1;
}

int main(void) {
    @autoreleasepool {
        NSData *input = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
        NSError *parseError = nil;
        NSDictionary *request = [NSJSONSerialization JSONObjectWithData:input options:0 error:&parseError];
        if (![request isKindOfClass:[NSDictionary class]]) {
            emit(@{ @"ok": @NO, @"error": @"invalid_request" });
            return 2;
        }

        NSString *operation = request[@"op"];
        NSString *service = request[@"service"];
        NSString *account = request[@"account"];
        if (![operation isKindOfClass:[NSString class]] || ![service isKindOfClass:[NSString class]] || ![account isKindOfClass:[NSString class]]) {
            emit(@{ @"ok": @NO, @"error": @"invalid_request" });
            return 2;
        }

        NSDictionary *query = baseQuery(service, account);
        if ([operation isEqualToString:@"get"]) {
            NSMutableDictionary *lookup = [query mutableCopy];
            lookup[(__bridge id)kSecReturnData] = @YES;
            lookup[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
            CFTypeRef result = NULL;
            OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)lookup, &result);
            if (status == errSecItemNotFound) {
                emit(@{ @"ok": @YES, @"found": @NO });
                return 0;
            }
            if (status != errSecSuccess) return failStatus(status);
            NSData *data = CFBridgingRelease(result);
            NSString *value = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
            if (!value) {
                emit(@{ @"ok": @NO, @"error": @"invalid_stored_value" });
                return 1;
            }
            emit(@{ @"ok": @YES, @"found": @YES, @"value": value });
            return 0;
        }

        if ([operation isEqualToString:@"set"]) {
            NSString *value = request[@"value"];
            if (![value isKindOfClass:[NSString class]]) {
                emit(@{ @"ok": @NO, @"error": @"invalid_value" });
                return 2;
            }
            NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
            NSMutableDictionary *attributes = [query mutableCopy];
            attributes[(__bridge id)kSecValueData] = data;
            attributes[(__bridge id)kSecAttrAccessible] = (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
            OSStatus status = SecItemAdd((__bridge CFDictionaryRef)attributes, NULL);
            if (status == errSecDuplicateItem) {
                status = SecItemUpdate((__bridge CFDictionaryRef)query, (__bridge CFDictionaryRef)@{
                    (__bridge id)kSecValueData: data,
                    (__bridge id)kSecAttrAccessible: (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
                });
            }
            if (status != errSecSuccess) return failStatus(status);
            emit(@{ @"ok": @YES });
            return 0;
        }

        if ([operation isEqualToString:@"delete"]) {
            OSStatus status = SecItemDelete((__bridge CFDictionaryRef)query);
            if (status != errSecSuccess && status != errSecItemNotFound) return failStatus(status);
            emit(@{ @"ok": @YES });
            return 0;
        }

        emit(@{ @"ok": @NO, @"error": @"unsupported_operation" });
        return 2;
    }
}
