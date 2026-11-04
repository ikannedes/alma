plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "mx.alma.nucleo"
    compileSdk = 35
    ndkVersion = "27.3.13750724"
    defaultConfig {
        minSdk = 26
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
    }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin { jvmToolchain(17) }

// el catálogo es el mismo del robot: se copia en cada compilación para que no se desfase
val copiarCatalogo by tasks.registering(Copy::class) {
    from(rootProject.file("../catalog/catalog.json"))
    into(file("src/main/assets"))
}
tasks.named("preBuild") { dependsOn(copiarCatalogo) }

dependencies {
    api(project(":protocolo"))
}
